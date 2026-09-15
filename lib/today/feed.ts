/**
 * The Today feed — composition, ranking and presentation.
 *
 * Lived inside app/api/today/route.ts until 2026-09-15, where it could only
 * be exercised through the HTTP handler. It is a pure server lib now: the
 * route authenticates, caches, and calls these two functions.
 */
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


/** Compute the full feed — the Gmail/Slack/Linear/delta fan-out (~5s). */
export async function computeTodayFeed(username: string): Promise<TodayFeedResponse> {
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

    // Connected is not the same as answering. A failed read is recorded as
    // degraded, not as "no issues" — an empty Linear during an outage used to
    // read as a quiet Linear, with sources.linear still true.
    let linearFailed = false;
    const issues: LinearIssue[] = linearOn
      ? await getMyOpenIssues(username).catch((e) => {
          console.warn("[today] linear failed:", e instanceof Error ? e.message : e);
          linearFailed = true;
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

    // Everything that qualified, deduped and ranked — NOT capped. The cap is
    // presentation (see presentFeed); the number a headline may show is this
    // one. It used to be applied here, so `total` was the capped figure and
    // twenty unanswered threads read as six with no sign six was a cut.
    const byId = new Map<string, TodayFeedItem>();
    for (const item of [...changeItems, ...followupItems, ...linearItems]) {
      if (!byId.has(item.id)) byId.set(item.id, item);
    }
    const all = [...byId.values()].sort(byRank);

    return {
      items: all,
      total: all.length,
      totals: { changes: changeItems.length, followups: followupItems.length, linear: linearItems.length },
      truncated: false,
      generatedAt: new Date().toISOString(),
      sources: {
        changes: true,
        followups: followupResult.sources,
        linear: linearOn,
      },
      degraded: linearFailed ? ["Linear"] : [],
    } satisfies TodayFeedResponse;
}

const byRank = (a: TodayFeedItem, b: TodayFeedItem) =>
  b.rank - a.rank || new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime();

/**
 * The display shape of a computed feed: per-source caps, then a global cap,
 * with `total`/`totals` reporting what there IS rather than what is shown.
 *
 * Tolerates responses cached before totals existed — those were already
 * capped, so their `total` is the best figure available until the cache
 * refreshes.
 */
export function presentFeed(feed: TodayFeedResponse, opts: { full?: boolean } = {}): TodayFeedResponse {
  const totals = feed.totals ?? {
    changes: feed.items.filter((i) => i.kind === "change").length,
    followups: feed.items.filter((i) => i.kind === "followup").length,
    linear: feed.items.filter((i) => i.kind === "linear").length,
  };
  const total = feed.totals ? feed.total : feed.items.length;
  const degraded = feed.degraded ?? [];
  if (opts.full) return { ...feed, totals, total, truncated: false, degraded };

  const top = (kind: TodayFeedItem["kind"], cap: number) =>
    feed.items.filter((i) => i.kind === kind).sort(byRank).slice(0, cap);
  const items = [
    ...top("change", CAP_PER_SOURCE.change),
    ...top("followup", CAP_PER_SOURCE.followup),
    ...top("linear", CAP_PER_SOURCE.linear),
  ].sort(byRank).slice(0, CAP_TOTAL);

  return { ...feed, items, totals, total, truncated: items.length < total, degraded };
}

