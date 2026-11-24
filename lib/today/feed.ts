/**
 * The Today feed — composition, ranking and presentation.
 *
 * Lived inside app/api/today/route.ts until 2026-09-15, where it could only
 * be exercised through the HTTP handler. It is a pure server lib now: the
 * route authenticates, caches, and calls these two functions.
 */
import { computeDeltas, buildKeyContactSet } from "@/lib/delta/compute";
import { getWorkCalendar } from "@/lib/away/store";
import { dayIn, pausedDays, workingHoursBetween, type WorkCalendar } from "@/lib/away/calendar";
import { SEVERITY_WEIGHT, CATEGORY_CONFIG, type ChangeSeverity, type ChangeEvent } from "@/lib/delta/types";
import { getSinceDate } from "@/lib/delta/store";
import { listActions } from "@/lib/actions/store";
import { listDecisions } from "@/lib/decisions/store";
import { listUserContacts } from "@/lib/contacts/user-store";
import { getAllOverridesFromStore } from "@/lib/contacts/overrides-store";
import type { ToneObservation } from "@/lib/contact-profile-overrides";
import { isLinearConnected, getMyOpenIssues, type LinearIssue } from "@/lib/linear/client";
import { getPipedriveConfig, getPipedriveSnapshot, activityUrl, dealUrl, type PipedriveSnapshot } from "@/lib/pipedrive/client";
import { suggestFollowups } from "@/lib/pipedrive/followups";
import { readAutomation } from "@/lib/pipedrive/automation";
import { dueActivities, daysBetween, emailDomain, isClientSender } from "@/lib/pipedrive/shape";
import { detectPendingFollowups } from "@/lib/followups/detect";
import { assignWorkstreams } from "@/lib/workstreams/classify";
import { actionSubject, feedSubject, stampFeed, workstreamTotals } from "@/lib/workstreams/attach";
import type { Workstream } from "@/lib/workstreams/types";
import { getLearning } from "@/lib/learning/store";
import { listMemories } from "@/lib/memory/store";
import { extractCadenceRules } from "@/lib/contacts/cadence-rules";
import { getSettings } from "@/lib/settings/store";
import { getSelfIdentity } from "@/lib/self-identity";
import { isWaitingOnOthers } from "@/lib/actions/utils";
import { computeCategoryPriors, taskClassOf, priorEffect } from "@/lib/learning/priors";
import type {
  TodayFeedItem,
  TodayFeedResponse,
  TodayChangeItem,
  TodayFollowupItem,
  TodayLinearItem,
  TodayPipedriveItem,
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
const CAP_PER_SOURCE = { change: 7, followup: 6, linear: 5, pipedrive: 5 } as const;
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
    const [since, allActions, decisions, contacts, learning, overrides, settings, memories, identity] = await Promise.all([
      getSinceDate(username),
      listActions(username),
      listDecisions(username),
      listUserContacts(username, { fresh: true }),
      getLearning(username),
      getAllOverridesFromStore(username).catch(() => ({})),
      getSettings(username).catch(() => null), // ci-ok: settings optional; TZ falls back to Europe/London
      listMemories(username).catch((e) => { console.warn("[today] memories failed:", e instanceof Error ? e.message : e); return []; }),
      getSelfIdentity(username).catch(() => ({ emails: [] as string[], names: [] as string[] })),
    ]);
    // Days off and leave do not count against anyone (lib/away). Stored values
    // only — the route refreshes the calendar read; this must not wait on Google.
    const workCal: WorkCalendar | null = await getWorkCalendar(username, { refresh: "never" }).catch((e) => {
      console.warn("[today] working calendar unreadable, clocks count every day:", e instanceof Error ? e.message : e);
      return null;
    });
    const nowMs = Date.now();
    const todayDay = workCal ? dayIn(nowMs, workCal.timezone) : null;
    const awayDaysSince = workCal && todayDay
      ? (iso: string) => { const t = Date.parse(iso); return Number.isFinite(t) ? pausedDays(dayIn(t, workCal.timezone), todayDay, workCal) : 0; }
      : undefined;
    // Only the user's own actions drive Today. Someone else's commitment
    // ("Carter to send the brochure") is waiting-on, not the user's work.
    const actions = allActions.filter((a) => !isWaitingOnOthers(a, identity.names));
    // "Keep in touch with Jane every 3 weeks" is a memory; the delta engine
    // honours it as that person's silence threshold.
    const cadenceRules = extractCadenceRules(memories, contacts);

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
        // The detector isolates its own sources; reaching here means the
        // detector itself failed. Unknown connectivity, and say so.
        console.warn("[today] followups failed:", e instanceof Error ? e.message : e);
        return { items: [], sources: { gmail: false, slack: false }, degraded: ["Follow-ups"] };
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

    // Pipedrive: overdue and due-today activities, plus the client directory
    // that files client mail under Clients & Sales. Same rule as Linear: a
    // failed read is "degraded", never "nothing due".
    const pdConfig = await getPipedriveConfig(username).catch((e) => {
      console.warn("[today] pipedrive config unreadable:", e instanceof Error ? e.message : e);
      return {};
    });
    const pipedriveOn = !!("apiToken" in pdConfig && pdConfig.apiToken);
    let pipedriveFailed = false;
    const ownDomains = [...new Set(identity.emails.map((e) => emailDomain(e)).filter((d): d is string => !!d))];
    const pd: PipedriveSnapshot | null = pipedriveOn
      ? await getPipedriveSnapshot(username, { ownDomains }).catch((e) => {
          console.warn("[today] pipedrive failed:", e instanceof Error ? e.message : e);
          pipedriveFailed = true;
          return null;
        })
      : null;

    // ── Map each source → TodayFeedItem, computing rank ───────────────────────

    // 1. Delta changes — score is already a composite (severity × category × recency).
    const delta = computeDeltas({ actions, decisions, contacts, since, toneHistory, timezone: settings?.timezone, cadenceRules, awayDaysSince });
    const keyContacts = buildKeyContactSet(contacts, toneHistory, new Map(cadenceRules.map((r) => [r.contactId, r])));
    const keyNames = new Set(contacts.filter((c) => keyContacts.has(c.id)).map((c) => c.name.trim().toLowerCase()));
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
          ...(typeof action?.confidence === "number" ? { confidence: action.confidence } : {}),
          // Lead with the SUBJECT — the task, the person — and let the kind of
          // change support it. "Due today" told the reader nothing until they
          // opened Why; the task's own text is the headline.
          title: change.subject ?? change.title,
          subtitle: change.subject ? change.title : change.context,
          occurredAt: change.occurredAt,
          href: change.entityHref,
          hint,
          suggest,
          change,
        };
      });

    // 2. Follow-ups — longest-waiting ranks highest; treated as urgency-category.
    const followupItems: TodayFollowupItem[] = followupResult.items.map((followup) => {
      // The clock runs on working days the user was not away: a message left
      // on Friday afternoon is not "critical" by Monday afternoon, and one left
      // before a fortnight's leave has waited since the day the user came back.
      const lastInbound = Date.parse(followup.lastInboundAt);
      const hoursCounted = workCal && Number.isFinite(lastInbound)
        ? workingHoursBetween(lastInbound, nowMs, workCal)
        : followup.hoursWaiting;
      const sev = followupSeverity(hoursCounted);
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
        ...(keyNames.has((followup.fromName ?? "").trim().toLowerCase()) ? { fromKeyContact: true } : {}),
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

    // 4. Pipedrive — your activities that are overdue or due today.
    const pdToday = dayIn(nowMs, workCal?.timezone ?? settings?.timezone ?? "Europe/London");
    const pipedriveItems: TodayPipedriveItem[] = [];
    if (pd) {
      const deals = new Map(pd.deals.map((d) => [d.id, d]));
      const persons = new Map(pd.persons.map((p) => [p.id, p]));
      const orgs = new Map(pd.orgs.map((o) => [o.id, o]));
      // Only your own open activities: colleagues' are context, not your Today.
      const mine = pd.activities.filter((a) => !a.done && (a.ownerId == null || a.ownerId === pd.userId));
      const { overdue, dueToday } = dueActivities(mine, pdToday);
      for (const a of [...overdue, ...dueToday]) {
        const overdueDays = daysBetween(a.dueDate!, pdToday);
        const deal = a.dealId ? deals.get(a.dealId) : undefined;
        const person = a.personId ? persons.get(a.personId) : undefined;
        const org = a.orgId ? orgs.get(a.orgId) : (person?.orgId ? orgs.get(person.orgId) : undefined);
        const sev: ChangeSeverity = overdueDays > 7 ? "critical" : overdueDays > 0 ? "high" : "medium";
        const when = overdueDays > 0 ? `overdue ${overdueDays} day${overdueDays === 1 ? "" : "s"}` : a.dueTime ? `today ${a.dueTime}` : "due today";
        const who = [person?.name, org?.name].filter(Boolean).join(", ");
        pipedriveItems.push({
          id: `pipedrive:activity:${a.id}`,
          kind: "pipedrive",
          // Constant recency: an overdue call does not fade because it was logged long ago.
          rank: SEVERITY_WEIGHT[sev] * CATEGORY_CONFIG.urgency.weight * 0.6,
          lane: sev === "critical" ? "critical" : "needs-you",
          title: a.subject,
          subtitle: [`${a.type} · ${when}`, who, deal ? `${deal.title} (${deal.stage})` : ""].filter(Boolean).join(" · "),
          occurredAt: a.dueDate ? `${a.dueDate}T${a.dueTime ?? "09:00"}:00Z` : a.updateTime,
          href: activityUrl("companyDomain" in pdConfig ? pdConfig.companyDomain : undefined, a),
          activity: a,
          overdueDays,
          ...(deal ? { dealTitle: deal.title } : {}),
          ...(person?.emails[0] ? { personEmail: person.emails[0].toLowerCase() } : {}),
        });
      }
    }

    // 5. Pipedrive — suggested follow-ups (opt-out in Settings → Pipedrive).
    if (pd) {
      const auto = await readAutomation(username).catch((e) => {
        console.warn("[today] pipedrive automation unreadable:", e instanceof Error ? e.message : e);
        return null;
      });
      if (auto && auto.mode !== "off") {
        const companyDomain = "companyDomain" in pdConfig ? pdConfig.companyDomain : undefined;
        const sugs = suggestFollowups(pd, { today: pdToday, staleDays: auto.staleDays, dismissed: auto.dismissed })
          .filter((s) => !auto.booked[s.id])
          .slice(0, 8);
        for (const s of sugs) {
          const sev: ChangeSeverity = s.kind === "after-meeting" || s.kind === "past-close" ? "high" : s.kind === "going-cold" ? "medium" : "low";
          pipedriveItems.push({
            id: `pipedrive:followup:${s.id}`,
            kind: "pipedrive",
            rank: SEVERITY_WEIGHT[sev] * CATEGORY_CONFIG.urgency.weight * 0.5,
            lane: s.kind === "no-next-step" ? "later" : "needs-you",
            title: s.title,
            subtitle: s.why,
            occurredAt: `${s.since}T09:00:00Z`,
            ...(s.dealId ? { href: dealUrl(companyDomain, s.dealId) } : {}),
            overdueDays: 0,
            followup: { ...s, schedulable: auto.mode === "schedule" },
            ...(s.dealTitle ? { dealTitle: s.dealTitle } : {}),
            ...(s.contactEmail ? { personEmail: s.contactEmail } : {}),
          });
        }
      }
    }

    // Everything that qualified, deduped and ranked — NOT capped. The cap is
    // presentation (see presentFeed); the number a headline may show is this
    // one. It used to be applied here, so `total` was the capped figure and
    // twenty unanswered threads read as six with no sign six was a cut.
    const byId = new Map<string, TodayFeedItem>();
    for (const item of [...changeItems, ...followupItems, ...linearItems, ...pipedriveItems]) {
      if (!byId.has(item.id)) byId.set(item.id, item);
    }
    const ranked = [...byId.values()].sort(byRank);

    // Workstreams (lib/workstreams): every card, and every open action — the
    // classifier runs here, in the background refresh, never on page load.
    const allById = new Map(allActions.map((a) => [a.id, a]));
    const subjects = [
      ...ranked.map((i) => feedSubject(i, allById)),
      ...allActions.filter((a) => a.status !== "done").map(actionSubject),
    ];
    const uniqueSubjects = [...new Map(subjects.map((s) => [s.key, s])).values()];
    const placed = await assignWorkstreams(username, uniqueSubjects, { isClient: pd ? (e?: string) => isClientSender(pd.directory, e) : undefined }).catch((e) => {
      console.warn("[today] workstreams failed:", e instanceof Error ? e.message : e);
      return new Map();
    });
    const all = stampFeed(ranked, placed);

    return {
      items: all,
      workstreamTotals: workstreamTotals(all),
      total: all.length,
      totals: { changes: changeItems.length, followups: followupItems.length, linear: linearItems.length, pipedrive: pipedriveItems.length },
      truncated: false,
      generatedAt: new Date().toISOString(),
      sources: {
        changes: true,
        followups: followupResult.sources,
        linear: linearOn,
        pipedrive: pipedriveOn,
      },
      degraded: [...(followupResult.degraded ?? []), ...(linearFailed ? ["Linear"] : []), ...(pipedriveFailed ? ["Pipedrive"] : [])],
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
export function presentFeed(feed: TodayFeedResponse, opts: { full?: boolean; workstream?: Workstream | "unsorted" } = {}): TodayFeedResponse {
  if (opts.workstream) {
    // One workstream: filter BEFORE the cap, so a quiet workstream is not
    // shown empty because the busier ones filled the sixteen slots. Totals
    // stay whole-feed — the bar shows every workstream's count.
    const want = opts.workstream;
    const wsTotals = feed.workstreamTotals ?? workstreamTotals(feed.items);
    const inWs = feed.items.filter((i) => (i.workstream ?? "unsorted") === want);
    const inner = presentFeed({ ...feed, items: inWs, totals: undefined, total: inWs.length, workstreamTotals: wsTotals }, { full: opts.full });
    return { ...inner, workstreamTotals: wsTotals };
  }
  const totals = feed.totals ?? {
    changes: feed.items.filter((i) => i.kind === "change").length,
    followups: feed.items.filter((i) => i.kind === "followup").length,
    linear: feed.items.filter((i) => i.kind === "linear").length,
    pipedrive: feed.items.filter((i) => i.kind === "pipedrive").length,
  };
  const total = feed.totals ? feed.total : feed.items.length;
  const degraded = feed.degraded ?? [];
  const wsTotals = feed.workstreamTotals ?? workstreamTotals(feed.items);
  if (opts.full) return { ...feed, totals, total, truncated: false, degraded, workstreamTotals: wsTotals };

  const top = (kind: TodayFeedItem["kind"], cap: number) =>
    feed.items.filter((i) => i.kind === kind).sort(byRank).slice(0, cap);
  const items = [
    ...top("change", CAP_PER_SOURCE.change),
    ...top("followup", CAP_PER_SOURCE.followup),
    ...top("linear", CAP_PER_SOURCE.linear),
    ...top("pipedrive", CAP_PER_SOURCE.pipedrive),
  ].sort(byRank).slice(0, CAP_TOTAL);

  return { ...feed, items, totals, total, truncated: items.length < total, degraded, workstreamTotals: wsTotals };
}

