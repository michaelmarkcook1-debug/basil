/**
 * lib/today/executive.ts
 *
 * The judgement layer for Today. Pure functions over the EXISTING contracts
 * (TodayFeedItem, CalendarEvent, ActionItem) — no fetching, no JSX, no new data.
 *
 * It lives apart from the page because the old Today had none of this: it
 * rendered the feed in rank order and let the reader do the triage. Eight
 * similarly-weighted alerts, three of them the same stakeholder-silence signal
 * repeated, and the schedule below all of it. A ledger, not a judgement.
 *
 * Every value here is derived from stored data. Where a question cannot be
 * answered from what exists — "how important is this person to you" — the
 * function returns the real observed quantity under its real name rather than
 * a score that sounds authoritative and means nothing.
 */

import type { TodayFeedItem, TodayFeedResponse } from "./types";
import type { CalendarEvent } from "@/lib/google/calendar";
import type { ActionItem } from "@/lib/types/action";

// ── Priority vocabulary ──────────────────────────────────────────────────────
// "URGENT" and "FLASH" are wire-service register: they say how a newsroom would
// have transmitted it, not what the reader should do. These say what to do.

export type Urgency = "act-now" | "today" | "watch";

export const URGENCY_LABEL: Record<Urgency, string> = {
  "act-now": "Act now",
  today: "Today",
  watch: "Watch",
};

/** Lane → urgency. The feed's lanes already encode real severity; this renames. */
export function urgencyOf(item: TodayFeedItem): Urgency {
  switch (item.lane) {
    case "critical": return "act-now";
    case "needs-you": return "today";
    default: return "watch"; // "linear" and "later" are both backlog pressure
  }
}

/** Provenance: did Basil observe this, or infer it? Drives the sourcing mark. */
export type Provenance = "observed" | "inferred";

export function provenanceOf(item: TodayFeedItem): Provenance {
  // followups and Linear issues are read directly off a system of record.
  // change events are computed by the delta engine against a baseline.
  return item.kind === "change" ? "inferred" : "observed";
}

/** Which integration this came from, for the provenance label. */
export function sourceOf(item: TodayFeedItem): string {
  if (item.kind === "linear") return "Linear";
  if (item.kind === "followup") return item.followup.source === "slack" ? "Slack" : "Gmail";
  return item.change.source === "contacts" ? "Contacts"
    : item.change.source === "actions" ? "Commitments"
    : item.change.source === "decisions" ? "Decisions"
    : "Basil";
}

// ── Priorities ───────────────────────────────────────────────────────────────

export interface Priority {
  id: string;
  urgency: Urgency;
  /** The action to take, as a title. */
  title: string;
  /** One sentence on why it matters. Never invented — see whyOf(). */
  why: string;
  /** Stakeholder / meeting / project this concerns, when the data names one. */
  context?: string;
  href?: string;
  provenance: Provenance;
  source: string;
  occurredAt: string;
  rank: number;
  /**
   * The specific evidence behind `why`, when the record carries something the
   * summary line does not already say. Left undefined when it would merely
   * restate `why` — a disclosure that repeats the sentence above it teaches the
   * reader that opening things is not worth doing.
   */
  detail?: string;
  /** Set when this card stands for several grouped signals. */
  groupedCount?: number;
  /** The items folded into this card, for the "Why?" disclosure. */
  members?: TodayFeedItem[];
}

/**
 * The one-sentence justification.
 *
 * Order matters: a ChangeEvent's `implication` is the engine's own statement of
 * downstream consequence ("→ 2 actions unblocked") and is the most decision-
 * useful line available. Falling back to `subtitle` keeps it honest — better a
 * plain restatement than a generated sentence that reads like analysis.
 */
function whyOf(item: TodayFeedItem): string {
  if (item.kind === "change" && item.change.implication) {
    return item.change.implication.replace(/^→\s*/, "");
  }
  return item.subtitle;
}

/**
 * The stakeholder, meeting or project this concerns — read off the record, so
 * a card can say WHO without the reader opening it.
 */
function contextOf(item: TodayFeedItem): string | undefined {
  if (item.kind === "followup") {
    const who = item.followup.fromName;
    const waited = item.followup.hoursWaiting;
    if (who && waited >= 1) {
      return waited >= 24
        ? `${who} · waiting ${Math.floor(waited / 24)}d`
        : `${who} · waiting ${waited}h`;
    }
    return who || undefined;
  }
  if (item.kind === "linear") return item.issue.project?.name || undefined;
  return undefined;
}

/** Evidence that adds to `why` rather than repeating it. */
function detailOf(item: TodayFeedItem, why: string): string | undefined {
  const norm = (t: string) => t.trim().toLowerCase().replace(/\.$/, "");
  const candidate =
    item.kind === "change" ? item.change.context
    : item.kind === "followup" ? item.followup.preview
    : item.kind === "linear" ? item.issue.state?.name
    : undefined;
  if (!candidate) return undefined;
  return norm(candidate) === norm(why) ? undefined : candidate;
}

function toPriority(item: TodayFeedItem): Priority {
  const why = whyOf(item);
  return {
    id: item.id,
    detail: detailOf(item, why),
    urgency: urgencyOf(item),
    title: item.title,
    why,
    context: contextOf(item),
    href: item.href,
    provenance: provenanceOf(item),
    source: sourceOf(item),
    occurredAt: item.occurredAt,
    rank: item.rank,
  };
}

/** True for the stakeholder-silence family of change events. */
export function isRelationshipRisk(item: TodayFeedItem): boolean {
  return item.kind === "change" && item.change.category === "relationship";
}

/**
 * Fold every relationship-risk signal into ONE card.
 *
 * Three separate "stakeholder has gone quiet" rows are not three decisions —
 * they are one decision ("who do I reconnect with today?") wearing three hats,
 * and they crowd out genuinely different work by occupying three of the top
 * slots. The individual signals survive inside `members`, so nothing is lost:
 * the card discloses them and each keeps its own deep link.
 *
 * A single relationship signal is left alone — grouping one thing is just
 * indirection.
 */
export function groupRelationshipRisk(items: TodayFeedItem[]): TodayFeedItem[] | null {
  const risks = items.filter(isRelationshipRisk);
  return risks.length > 1 ? risks : null;
}

/** Names the grouped card should list, deduped, in rank order. */
function namesFrom(items: TodayFeedItem[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const i of items) {
    // The engine puts the person in the title; the context line carries detail.
    const name = i.title.replace(/\s*(has|have)\s+gone\s+quiet.*$/i, "").trim();
    const key = name.toLowerCase();
    if (name && !seen.has(key)) { seen.add(key); out.push(name); }
  }
  return out;
}

export interface PriorityBoard {
  /** At most three, expanded by default. */
  top: Priority[];
  /** Everything else, collapsed. */
  watchlist: Priority[];
}

export const TOP_PRIORITY_LIMIT = 3;

/**
 * Rank, group, and split into "decide now" vs "later".
 *
 * The feed arrives sorted by rank already; the work here is the grouping and
 * the cut. Three is not a styling choice — it is the number of things a person
 * can hold while deciding what to do next.
 */
export function buildPriorityBoard(items: TodayFeedItem[]): PriorityBoard {
  const risks = groupRelationshipRisk(items);
  const riskIds = new Set(risks?.map((r) => r.id) ?? []);

  const singles = items.filter((i) => !riskIds.has(i.id)).map(toPriority);

  let all: Priority[] = singles;
  if (risks) {
    const names = namesFrom(risks);
    const lead = risks[0];
    all = [
      ...singles,
      {
        id: "group:relationship-risk",
        // Silence is never "act now" on its own — it is the definition of a
        // thing that has been true for a while. Today, not an interrupt.
        urgency: "today",
        title: `${risks.length} relationships need attention`,
        why:
          names.length > 0
            ? `No meaningful contact recently with ${names.slice(0, 3).join(", ")}` +
              (names.length > 3 ? ` and ${names.length - 3} more` : "") + "."
            : "Several stakeholders have gone quiet.",
        provenance: "inferred",
        source: "Contacts",
        occurredAt: lead.occurredAt,
        // Ranked as the strongest member, so grouping never buries the signal.
        rank: Math.max(...risks.map((r) => r.rank)),
        groupedCount: risks.length,
        members: risks,
        href: "/dashboard/contacts",
      },
    ];
  }

  all.sort((a, b) => b.rank - a.rank || a.occurredAt.localeCompare(b.occurredAt));
  return { top: all.slice(0, TOP_PRIORITY_LIMIT), watchlist: all.slice(TOP_PRIORITY_LIMIT) };
}

// ── The shape of the day ─────────────────────────────────────────────────────

export interface DaySegment {
  kind: "meeting" | "gap";
  start: string;
  end: string;
  minutes: number;
  event?: CalendarEvent;
  /** Meeting starts within 5 minutes of the previous one ending. */
  backToBack?: boolean;
}

export interface DayShape {
  segments: DaySegment[];
  meetingCount: number;
  meetingMinutes: number;
  /** Unbooked minutes BETWEEN the first and last meeting — not "free time". */
  gapMinutes: number;
  /** Longest single uninterrupted gap, the only real focus block available. */
  longestGapMinutes: number;
  backToBackRuns: number;
  allDay: CalendarEvent[];
  firstStart?: string;
  lastEnd?: string;
}

const MIN = 60_000;
const mins = (a: string, b: string) => Math.max(0, (new Date(b).getTime() - new Date(a).getTime()) / MIN);

/**
 * Turn today's events into meetings and the gaps between them.
 *
 * Gap minutes are measured only BETWEEN the first and last meeting. Counting
 * from midnight would report a mostly-empty day as eight hours of focus time,
 * which is the kind of true-but-useless number that makes a dashboard feel
 * like it is not paying attention.
 */
export function buildDayShape(events: CalendarEvent[], now: Date = new Date()): DayShape {
  const today = now.toISOString().slice(0, 10);
  const onToday = events.filter((e) => (e.start ?? "").slice(0, 10) === today);
  const allDay = onToday.filter((e) => e.isAllDay);
  const timed = onToday
    .filter((e) => !e.isAllDay && e.start && e.end)
    .sort((a, b) => a.start.localeCompare(b.start));

  const segments: DaySegment[] = [];
  let gapMinutes = 0, longestGapMinutes = 0, backToBackRuns = 0;

  timed.forEach((e, i) => {
    const prev = timed[i - 1];
    if (prev) {
      const gap = mins(prev.end, e.start);
      if (gap > 5) {
        segments.push({ kind: "gap", start: prev.end, end: e.start, minutes: gap });
        gapMinutes += gap;
        longestGapMinutes = Math.max(longestGapMinutes, gap);
      } else if (gap >= 0) {
        backToBackRuns += 1;
      }
    }
    segments.push({
      kind: "meeting",
      start: e.start,
      end: e.end,
      minutes: mins(e.start, e.end),
      event: e,
      backToBack: prev ? mins(prev.end, e.start) <= 5 : false,
    });
  });

  return {
    segments,
    meetingCount: timed.length,
    meetingMinutes: timed.reduce((s, e) => s + mins(e.start, e.end), 0),
    gapMinutes,
    longestGapMinutes,
    backToBackRuns,
    allDay,
    firstStart: timed[0]?.start,
    lastEnd: timed[timed.length - 1]?.end,
  };
}

/**
 * A meeting needs preparation when the stored record says so — never a guess.
 * Each reason is a fact from the event: unanswered RSVP, many attendees, or an
 * external video call. Returned as reasons, so the UI can say WHY.
 */
export function preparationReasons(e: CalendarEvent): string[] {
  const out: string[] = [];
  // Only conditions the reader can ACT on. An earlier version also flagged
  // "external call you did not organise", which matched nearly every meeting in
  // a normal week — a flag that fires on everything marks nothing, and three
  // amber blocks in a four-meeting day trained the eye to skip all of them.
  if (e.myResponseStatus === "needsAction") out.push("Unanswered invite");
  else if (e.myResponseStatus === "tentative") out.push("You are tentative");
  if (e.attendeeCount >= 6) out.push(`${e.attendeeCount} attendees`);
  return out;
}

// ── Commitment ageing ────────────────────────────────────────────────────────

export interface AgeingBuckets {
  overdue: ActionItem[];
  today: ActionItem[];
  next7: ActionItem[];
  /** Open, no due date, untouched for 30+ days. Not overdue — forgotten. */
  stalled: ActionItem[];
  total: number;
}

const STALLED_DAYS = 30;

export function bucketCommitments(actions: ActionItem[], now: Date = new Date()): AgeingBuckets {
  const today = now.toISOString().slice(0, 10);
  const in7 = new Date(now.getTime() + 7 * 86400_000).toISOString().slice(0, 10);
  const stalledBefore = new Date(now.getTime() - STALLED_DAYS * 86400_000).toISOString();

  const open = actions.filter((a) => a.status !== "done");
  const b: AgeingBuckets = { overdue: [], today: [], next7: [], stalled: [], total: open.length };

  for (const a of open) {
    const due = a.dueDate?.slice(0, 10);
    if (a.status === "overdue" || (due && due < today)) b.overdue.push(a);
    else if (due === today) b.today.push(a);
    else if (due && due <= in7) b.next7.push(a);
    else if (!due) {
      const touched = (a as { updatedAt?: string; createdAt?: string }).updatedAt
        ?? (a as { createdAt?: string }).createdAt;
      if (!touched || touched < stalledBefore) b.stalled.push(a);
    }
  }
  return b;
}

// ── Integration honesty ──────────────────────────────────────────────────────

export interface SourceState { label: string; connected: boolean }

/**
 * Which integrations are actually connected.
 *
 * This is what stops an empty Today reading as a calm one. "No follow-ups
 * waiting" and "Gmail is not connected" produce an identical empty list, and
 * reporting the second as the first is the failure this whole surface exists
 * to avoid.
 */
export function sourceStates(sources: TodayFeedResponse["sources"]): SourceState[] {
  return [
    { label: "Gmail", connected: !!sources?.followups?.gmail },
    { label: "Slack", connected: !!sources?.followups?.slack },
    { label: "Linear", connected: !!sources?.linear },
    { label: "Basil signals", connected: !!sources?.changes },
  ];
}

export function disconnected(sources: TodayFeedResponse["sources"]): string[] {
  return sourceStates(sources).filter((s) => !s.connected).map((s) => s.label);
}

// ── The operational read ─────────────────────────────────────────────────────

/**
 * Basil's one-or-two sentence synthesis: the shape of the day, then the
 * principal risk.
 *
 * Assembled from counted facts, deliberately NOT generated by a model. A
 * sentence that costs a model call cannot be shown on a page that must render
 * when the AI budget is spent — and an executive read that disappears when the
 * cap is hit is worse than one written in plain arithmetic.
 */
/** "a", "a and b", "a, b and c". */
export function listOf(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function operationalRead(
  board: PriorityBoard,
  day: DayShape,
  missing: string[],
  calendarConnected = true,
): { shape: string; risk: string | null } {
  const parts: string[] = [];

  if (!calendarConnected) {
    // NOT "no meetings today". A disconnected calendar and an empty one produce
    // an identical DayShape, and reporting the first as the second is the exact
    // failure this surface exists to prevent — stated in the headline sentence,
    // where it is least recoverable.
    parts.push("Basil cannot see your calendar, so the shape of your day is unknown.");
  } else if (day.meetingCount === 0) {
    parts.push("No meetings scheduled today.");
  } else {
    const h = Math.round((day.meetingMinutes / 60) * 10) / 10;
    parts.push(
      `${day.meetingCount} meeting${day.meetingCount === 1 ? "" : "s"} today, ${h}h booked` +
      (day.longestGapMinutes >= 45
        ? `, longest clear stretch ${Math.floor(day.longestGapMinutes / 60)}h${String(Math.round(day.longestGapMinutes % 60)).padStart(2, "0")}.`
        : day.meetingCount > 1 ? ", with no clear stretch over 45 minutes." : "."),
    );
  }

  let risk: string | null = null;
  const actNow = board.top.filter((p) => p.urgency === "act-now");
  if (actNow.length > 0) {
    risk = actNow.length === 1
      ? `Principal risk: ${actNow[0].title.toLowerCase()}.`
      : `Principal risk: ${actNow.length} items need action now.`;
  } else if (day.backToBackRuns >= 2) {
    risk = `Principal risk: ${day.backToBackRuns} back-to-back transitions leave no reset between meetings.`;
  } else if (board.top.length > 0) {
    risk = `Principal risk: ${board.top[0].title.toLowerCase()}.`;
  }

  if (missing.length > 0) {
    parts.push(`${listOf(missing)} ${missing.length === 1 ? "is" : "are"} not connected, so this read is partial.`);
  }

  return { shape: parts.join(" "), risk };
}

// ── The executive stat row ───────────────────────────────────────────────────

/**
 * The five headline counts.
 *
 * A hero-metric row is the category's laziest page scaffold, and the craft floor
 * refuses it by default — a big number with a small label under it usually says
 * nothing a reader can act on. It is built here because the owner pinned it, and
 * it earns its place on two conditions: every figure is COUNTED from a store,
 * never estimated, and every figure is a link to the thing it counts. A number
 * you cannot click is decoration.
 *
 * `unavailable` is the reason a count could not be read. It is deliberately
 * distinct from zero: "0 awaiting reply" and "Gmail is disconnected so Basil
 * cannot see what is awaiting reply" are the same integer and opposite facts.
 */
export interface Stat {
  key: string;
  label: string;
  count: number;
  href: string;
  /** Set when the count is unknown rather than zero. */
  unavailable?: string;
  /** Marks the figure that should read as pressure rather than information. */
  urgent?: boolean;
}

export function buildStatRow(
  items: TodayFeedItem[],
  day: DayShape,
  buckets: AgeingBuckets | null,
  sources: TodayFeedResponse["sources"] | undefined,
  calendarConnected: boolean,
): Stat[] {
  const actNow = items.filter((i) => urgencyOf(i) === "act-now").length;
  const followups = items.filter((i) => i.kind === "followup").length;
  const quiet = items.filter(isRelationshipRisk).length;
  const mailConnected = !!sources?.followups?.gmail || !!sources?.followups?.slack;

  return [
    { key: "act", label: "Act now", count: actNow, href: "/dashboard/actions", urgent: actNow > 0 },
    {
      key: "meet", label: "Meetings today", count: day.meetingCount, href: "/dashboard/schedule",
      unavailable: calendarConnected ? undefined : "Calendar not connected",
    },
    {
      key: "reply", label: "Awaiting your reply", count: followups, href: "/dashboard/threads",
      unavailable: mailConnected ? undefined : "Gmail and Slack not connected",
    },
    {
      key: "overdue", label: "Overdue", count: buckets?.overdue.length ?? 0,
      href: "/dashboard/actions?filter=overdue",
      unavailable: buckets ? undefined : "Commitments could not be read",
      urgent: (buckets?.overdue.length ?? 0) > 0,
    },
    {
      key: "quiet", label: "Gone quiet", count: quiet, href: "/dashboard/contacts",
      unavailable: sources?.changes ? undefined : "Basil signals unavailable",
    },
  ];
}

// ── Signal provenance ────────────────────────────────────────────────────────

export interface SignalSlice { source: string; count: number }

/**
 * Where today's signal actually came from.
 *
 * The reference calls this a radar and draws a ring. A ring answers "what share
 * of the whole", which nobody asks about their own inbox — so this reports the
 * counts per channel and lets the bar lengths carry the comparison. Same
 * position in the layout, a question worth answering.
 */
export function signalBreakdown(items: TodayFeedItem[]): SignalSlice[] {
  const counts = new Map<string, number>();
  for (const i of items) {
    const s = sourceOf(i);
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count);
}
