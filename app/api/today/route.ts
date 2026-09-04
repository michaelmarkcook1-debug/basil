import { NextResponse, after } from "next/server";
import {
  readGenerateCache,
  writeGenerateCache,
  isCacheValid,
  computeInputHash,
  TODAY_FEED_TTL_MS,
} from "@/lib/generate-cache/store";
import { getSessionUser } from "@/lib/auth";
import { computeDeltas } from "@/lib/delta/compute";
import { SEVERITY_WEIGHT, CATEGORY_CONFIG, type ChangeSeverity, type ChangeEvent } from "@/lib/delta/types";
import { getSinceDate } from "@/lib/delta/store";
import { listActions } from "@/lib/actions/store";
import { listDecisions } from "@/lib/decisions/store";
import { listUserContacts } from "@/lib/contacts/user-store";
import { getAllOverridesFromStore } from "@/lib/contacts/overrides-store";
import type { ToneObservation } from "@/lib/contact-profile-overrides";
import { isLinearConnected, getMyOpenIssues, type LinearIssue } from "@/lib/linear/client";
import { detectPendingFollowups } from "@/lib/followups/detect";
import { getLearning } from "@/lib/learning/store";
import { getSettings } from "@/lib/settings/store";
import { computeCategoryPriors, taskClassOf, priorEffect } from "@/lib/learning/priors";
import type {
  TodayFeedItem,
  TodayFeedResponse,
  TodayChangeItem,
  TodayFollowupItem,
  TodayLinearItem,
  TodayLane,
  SuggestVerb,
} from "@/lib/today/types";

/**
 * GET /api/today — the merged, ranked "Radar" feed.
 *
 * Composes three real, data-backed sources server-side (it calls the libs
 * directly — it does NOT HTTP-fetch its own sibling routes):
 *   • delta ChangeEvents (overdue/stalling work + cooling-stakeholder events)
 *   • awaiting-your-reply follow-ups (Gmail + Slack)
 *   • hot Linear issues
 *
 * Each source is fault-isolated: a failing integration yields [] + sources.<x>
 * = false rather than 500-ing the whole feed. Items interleave by a single
 * composite `rank` on the ChangeEvent.score scale.
 */

const CAP_TOTAL = 16;
const CAP_PER_SOURCE = { change: 7, followup: 6, linear: 5 } as const;
const DUE_SOON_MS = 48 * 3_600_000;

// Informational deltas ("a thing was created / resolved / re-engaged") are not
// "needs you" — the home only surfaces changes that call for action. We drop
// them by their delta semantics rather than by title (robust to copy changes).
const INFORMATIONAL_DELTA_TO = new Set(["open", "done", "active"]);
function isActionableChange(c: ChangeEvent): boolean {
  if (c.delta.field === "created") return false; // "Decision logged" / new record
  if (c.delta.to && INFORMATIONAL_DELTA_TO.has(c.delta.to)) return false; // tracked / resolved / re-engaged
  return true;
}

/** ~8h half-life exponential recency decay (mirrors lib/delta/compute.ts). */
function recency(occurredAtISO: string): number {
  const hoursAgo = (Date.now() - new Date(occurredAtISO).getTime()) / 3_600_000;
  if (!Number.isFinite(hoursAgo)) return 0.5;
  return Math.exp(-Math.max(0, hoursAgo) / 8);
}

function followupSeverity(hoursWaiting: number): ChangeSeverity {
  if (hoursWaiting > 72) return "critical";
  if (hoursWaiting > 48) return "high";
  return "medium";
}

// after() background refreshes run on the same invocation, so the budget must
// cover a full fan-out recompute — mirrors contacts/activity.
export const maxDuration = 120;

/** Compute the full feed — the Gmail/Slack/Linear/delta fan-out (~5s). */
async function computeTodayFeed(username: string): Promise<TodayFeedResponse> {
    // ── Core inputs (local stores — must succeed for the feed to compute) ──────
    const [since, actions, decisions, contacts, learning, overrides, settings] = await Promise.all([
      getSinceDate(username),
      listActions(username),
      listDecisions(username),
      listUserContacts(username, { fresh: true }),
      getLearning(username),
      getAllOverridesFromStore(username).catch(() => ({})),
      getSettings(username).catch(() => null), // ci-ok: settings optional; TZ falls back to Europe/London
    ]);

    // Per-contact tone history (warming/cooling) → the delta engine promotes
    // recent shifts into home-feed cards.
    const toneHistory = new Map<string, ToneObservation[]>();
    for (const [cid, ov] of Object.entries(overrides)) {
      if (ov?.toneHistory?.length) toneHistory.set(cid, ov.toneHistory);
    }

    // Learned per-category behaviour priors + a fast action lookup, so each
    // action-backed feed item can be re-ranked / re-laned by how the user
    // habitually treats that kind of task.
    const priors = computeCategoryPriors(learning);
    const actionMap = new Map(actions.map((a) => [a.id, a]));

    // ── Integration sources, each fault-isolated ──────────────────────────────
    const [followupResult, linearOn] = await Promise.all([
      detectPendingFollowups(username).catch((e) => {
        console.warn("[today] followups failed:", e instanceof Error ? e.message : e);
        return { items: [], sources: { gmail: false, slack: false } };
      }),
      isLinearConnected(username).catch(() => false),
    ]);

    const issues: LinearIssue[] = linearOn
      ? await getMyOpenIssues(username).catch((e) => {
          console.warn("[today] linear failed:", e instanceof Error ? e.message : e);
          return [];
        })
      : [];

    // ── Map each source → TodayFeedItem, computing rank ───────────────────────

    // 1. Delta changes — score is already a composite (severity × category × recency).
    const delta = computeDeltas({ actions, decisions, contacts, since, toneHistory, timezone: settings?.timezone });
    const changeItems: TodayChangeItem[] = delta.changes
      .filter(isActionableChange)
      .map((change) => {
        // Urgency (overdue / due-today) always reads as critical, regardless of
        // the engine's severity grading, so deadlines pop in the critical strip.
        const baseLane: TodayLane =
          change.category === "urgency" || change.severity === "critical" ? "critical" : "needs-you";
        let rank = change.score;
        let lane: TodayLane = baseLane;
        let hint: string | undefined;
        let suggest: SuggestVerb | undefined;

        // Apply the learned disposition for this action's task-class.
        const action =
          change.source === "actions" && change.entityId ? actionMap.get(change.entityId) : undefined;
        if (action) {
          const prior = priors[taskClassOf(action.category, action.source)];
          if (prior && prior.disposition !== "neutral") {
            const eff = priorEffect(prior.disposition);
            rank *= eff.rankMult;
            hint = eff.hint;
            suggest = eff.suggest;
            // Never bury a genuinely critical (due-today / overdue) item, even if
            // the user habitually defers that category.
            if (eff.lane === "later" && baseLane !== "critical") lane = "later";
          }
        }

        return {
          id: `change:${change.id}`,
          kind: "change",
          rank,
          lane,
          title: change.title,
          subtitle: change.context,
          occurredAt: change.occurredAt,
          href: change.entityHref,
          hint,
          suggest,
          change,
        };
      });

    // 2. Follow-ups — longest-waiting ranks highest; treated as urgency-category.
    const followupItems: TodayFollowupItem[] = followupResult.items.map((followup) => {
      const sev = followupSeverity(followup.hoursWaiting);
      return {
        id: followup.id,
        kind: "followup",
        rank: SEVERITY_WEIGHT[sev] * CATEGORY_CONFIG.urgency.weight * recency(followup.lastInboundAt),
        // A days-old unanswered message from a real person is critical-lane, not
        // buried under "needs you" — followupSeverity already escalates by wait time.
        lane: sev === "critical" ? "critical" : "needs-you",
        title: `Reply to ${followup.fromName}`,
        subtitle: `${followup.subject} · ${followup.hoursWaiting}h waiting`,
        occurredAt: followup.lastInboundAt,
        href: followup.href,
        followup,
      };
    });

    // 3. Linear — only "hot" issues (Urgent/High priority or due within 48h).
    const linearItems: TodayLinearItem[] = issues
      .map((issue): TodayLinearItem | null => {
        const dueMs = issue.dueDate ? new Date(issue.dueDate).getTime() : null;
        const dueSoon = dueMs !== null && dueMs - Date.now() < DUE_SOON_MS;
        let sev: ChangeSeverity | null = null;
        if (issue.priority === 1) sev = "critical";
        else if (issue.priority === 2) sev = "high";
        else if (dueSoon) sev = "high";
        if (!sev) return null; // not hot — skip
        return {
          id: `linear:${issue.id}`,
          kind: "linear",
          rank: SEVERITY_WEIGHT[sev] * CATEGORY_CONFIG.urgency.weight * recency(issue.updatedAt),
          lane: "linear",
          title: `${issue.identifier} ${issue.title}`,
          subtitle: issue.project?.name ? `${issue.state.name} · ${issue.project.name}` : issue.state.name,
          occurredAt: issue.updatedAt,
          href: issue.url,
          issue,
        };
      })
      .filter((i): i is TodayLinearItem => i !== null);

    // ── Per-source cap → merge → dedup → global cap ───────────────────────────
    const capped = [
      ...[...changeItems].sort((a, b) => b.rank - a.rank).slice(0, CAP_PER_SOURCE.change),
      ...[...followupItems].sort((a, b) => b.rank - a.rank).slice(0, CAP_PER_SOURCE.followup),
      ...[...linearItems].sort((a, b) => b.rank - a.rank).slice(0, CAP_PER_SOURCE.linear),
    ];

    const byId = new Map<string, TodayFeedItem>();
    for (const item of capped) if (!byId.has(item.id)) byId.set(item.id, item);

    const items = [...byId.values()]
      .sort((a, b) => b.rank - a.rank || new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
      .slice(0, CAP_TOTAL);

    return {
      items,
      total: items.length,
      generatedAt: new Date().toISOString(),
      sources: {
        changes: true,
        followups: followupResult.sources,
        linear: linearOn,
      },
    } satisfies TodayFeedResponse;
}

/**
 * GET /api/today — stale-while-revalidate over computeTodayFeed.
 *
 * Was: the full fan-out ran INLINE on every home-screen load (~5s). The only
 * mitigation was a 90s per-instance memo inside detectPendingFollowups, which
 * almost never hits in prod — each lambda instance has its own memory.
 *
 * Now (the same shape as /api/contacts/activity, 14s → ~200ms):
 *   fresh cache  → instant
 *   stale cache  → serve INSTANTLY, recompute in the background via after()
 *   no cache     → compute once, then it's warm
 */
export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  try {
    // fresh: read Blob, not the per-instance /tmp copy — the whole point is a
    // cache that's shared across instances.
    const cached = await readGenerateCache<TodayFeedResponse>(username, "today-feed", { fresh: true });

    if (cached?.content) {
      if (isCacheValid(cached)) {
        return NextResponse.json({ ...cached.content, cache: "hit" });
      }
      // Stale: hand back what we have immediately, refresh after the response.
      after(async () => {
        try {
          const fresh = await computeTodayFeed(username);
          await writeGenerateCache(username, "today-feed", fresh, {
            inputHash: computeInputHash(username, fresh.generatedAt),
            ttlMs: TODAY_FEED_TTL_MS,
          });
        } catch (e) {
          console.error("[today] background refresh failed:", e instanceof Error ? e.message : e);
        }
      });
      return NextResponse.json({ ...cached.content, cache: "stale" });
    }

    // Cold start — pay for it once.
    const fresh = await computeTodayFeed(username);
    await writeGenerateCache(username, "today-feed", fresh, {
      inputHash: computeInputHash(username, fresh.generatedAt),
      ttlMs: TODAY_FEED_TTL_MS,
    }).catch((e) => console.error("[today] cache write failed:", e));
    return NextResponse.json({ ...fresh, cache: "miss" });
  } catch (err) {
    console.error("[today]", err);
    return NextResponse.json({ error: "Failed to build today feed." }, { status: 500 });
  }
}
