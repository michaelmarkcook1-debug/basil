/**
 * lib/actions/review.ts — the daily review of the whole open list (2026-11-25).
 *
 * Owner, 2026-11-25: "basil needs to be more intelligent with open tasks and
 * promises. Many open tasks." That morning 116 were open: 73 from meeting
 * notes, 58 over 30 days old, 39 with no owner, around 20 someone else's, and
 * the same Decision Desk follow-up written six ways. Every pass that existed
 * looked at one item at a time (the rules in listActions, the thread re-read in
 * resolve-threads.ts, the done-check in check-done.ts), so none could see that
 * two items were the same work, that "Explore a monthly podcast" was an idea
 * from a meeting rather than a task, or that "Roger to finish the backfill" was
 * Roger's.
 *
 * Once a day Claude reads the whole list together with what the user sent
 * (email and Slack) and the meetings they held, and says for each item: keep,
 * done, duplicate of another, someone else's, not a task, or its moment passed.
 * Closing live work is the dangerous direction (basil-outbound-blindness), so:
 * only confident verdicts apply; the user's own items (typed, from chat, from
 * Linear, delegated, ongoing, reopened) are never put to it; at most three
 * quarters of the list closes in one run; every close says why in the item's
 * notes; and anything can be reopened, which the next review learns from
 * (done-lessons).
 *
 * A run Claude could not answer is not a run (2026-11-26): that morning the
 * Anthropic credit was out at 05:45, the judge's failure read as "keep
 * everything", and the day was recorded as reviewed, so a top-up would not have
 * brought the review back until the next morning. Now the day is recorded only
 * when Claude answered. A billing refusal costs nothing and is fixed by a top-up,
 * so it is retried on the next trigger; any other failure (a timeout, an answer
 * that does not parse) can cost money, so it is tried at most three times a day.
 */
import "server-only";
import { z } from "zod";
import type { ActionItem } from "@/lib/types/action";
import { listActions, bulkUpdateActions } from "@/lib/actions/store";
import { loadOutbound } from "@/lib/actions/check-done";
import type { OutboundEvent } from "@/lib/briefing/outbound-evidence";
import { readCalendar } from "@/lib/calendar/unified";
import { getSelfIdentity } from "@/lib/self-identity";
import { getSettings } from "@/lib/settings/store";
import { getWorkCalendar } from "@/lib/away/store";
import { readDoneLessons, lessonsBlock, type DoneLesson } from "@/lib/actions/done-lessons";
import { readUserStore, writeUserStore } from "@/lib/storage/user-store";
import { withLock } from "@/lib/events/lock";
import { generateTextSafe } from "@/lib/ai/generate";
import { getTextModel } from "@/lib/ai/model-config";
import { parseAndValidate } from "@/lib/ai/parse-json";
import { isBillingError } from "@/lib/ai/provider-health";

/** Below this the verdict is treated as "keep". */
export const REVIEW_MIN_CONFIDENCE = 0.8;
/**
 * Lower bars for the verdicts that only clear noise: an item that was never a
 * task, or is someone else's. In the first run on real data (2026-11-25) Claude
 * put five test-platform notifications at exactly 0.7 "not a task".
 */
export const REVIEW_MIN_BY_VERDICT: Partial<Record<ReviewVerdictKind, number>> = { not_a_task: 0.7, not_mine: 0.7 };
/** No run closes more than this share of what it reviewed. */
export const REVIEW_MAX_SHARE = 0.75;
/** Days of sent mail, Slack and meetings the review reads. */
export const REVIEW_LOOKBACK_DAYS = 30;
/** Tasks per model call. Duplicates are only seen within one call, so it is large. */
const PER_CALL = 150;

const AUTO_SOURCES = new Set(["email", "slack", "teams", "meeting"]);

export type ReviewVerdictKind = "keep" | "done" | "duplicate" | "not_mine" | "not_a_task" | "expired";

export const ReviewSchema = z.object({
  items: z.array(z.object({
    t: z.string(),
    verdict: z.enum(["keep", "done", "duplicate", "not_mine", "not_a_task", "expired"]),
    of: z.string().optional(),
    reason: z.string().optional().default(""),
    evidence: z.string().optional().default(""),
    confidence: z.number().min(0).max(1).optional().default(0),
  })),
});
export type ReviewItem = z.infer<typeof ReviewSchema>["items"][number];

export interface ReviewMeeting { date: string; title: string; with: string[] }

/** Put to the review: open, extracted by Basil, and not something the user has taken charge of. */
export function reviewable(a: ActionItem): boolean {
  if (a.status !== "open" && a.status !== "overdue") return false;
  if (!AUTO_SOURCES.has(a.source)) return false;
  return !a.delegatedAt && !a.ongoing && !a.reopenedAt;
}

const clip = (s: string, n: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function reviewPrompt(input: {
  firstName: string;
  selfNames: readonly string[];
  today: string;
  tasks: ReadonlyArray<{ t: string; a: ActionItem }>;
  outbound: readonly OutboundEvent[];
  meetings: readonly ReviewMeeting[];
  absences: readonly string[];
  lessons: string;
}): string {
  const { firstName } = input;
  const names = input.selfNames.length ? ` (also written ${input.selfNames.slice(0, 4).join(", ")})` : "";
  const taskLines = input.tasks.map(({ t, a }) =>
    `${t} | ${a.createdAt.slice(0, 10)} from ${a.source} | owner: ${clip(a.owner || "not named", 30)}${a.dueDate ? ` | due ${a.dueDate.slice(0, 10)}` : ""}${a.commitment ? ` | promised to ${clip(a.commitment.to, 40)}` : ""} | ${clip(a.text, 220)}`);
  const sent = input.outbound.map((e) => `${e.at.slice(0, 10)} ${e.channel} to ${clip(e.to, 60)}: ${clip(e.subject, 90)} | ${clip(e.text, 160)}`);
  const met = input.meetings.map((m) => `${m.date} "${clip(m.title, 80)}"${m.with.length ? ` with ${m.with.join(", ")}` : ""}`);
  return `Today is ${input.today}. You are reviewing ${firstName}'s open task list${names}. Basil extracted these from email, Slack and meeting notes; many are stale, repeated, someone else's, or were never tasks.

For EVERY task give one verdict:
- "done": what ${firstName} sent, or a meeting ${firstName} held, clearly shows it was carried out. Name that message or meeting in "evidence".
- "duplicate": the same piece of work as another task in this list (same people, same deliverable, however it is worded). Put the task to keep in "of": the clearest one, or the one with a due date or a promise. The task you keep must itself be "keep".
- "not_mine": someone else's job that ${firstName} does not need to chase ("Roger to finish the backfill", "Jessie to brief Alexia"). If it is something ${firstName} is waiting on and it still matters, "keep".
- "not_a_task": no concrete next step for ${firstName}: an idea or theme from a meeting ("Continue shaping the narrative", "Explore a monthly podcast"), a blocker or observation ("Blocker: need to verify data accuracy"), an FYI, or an automatic or test notification (product invite links, test submissions, sign-up prompts).
- "expired": its moment has passed: a scheduling request for a meeting that has happened, or any scheduling request more than two weeks old; a bare alert with no detail ("Unblock: X flagged a blocker in #channel", "Provide decision requested by X in #channel") more than two weeks old; a reply that stopped mattering weeks ago; an event that is over.
- "keep": anything else, and whenever you are unsure.

Closing work that is still live is far worse than leaving a stale item open. Give "confidence" from 0 to 1; only verdicts you are sure of matter. ${input.absences.length ? `${firstName} was away ${input.absences.join("; ")}: silence during those days is not evidence of anything.` : ""}

${input.lessons}TASKS
${taskLines.join("\n")}

WHAT ${firstName.toUpperCase()} SENT (last ${REVIEW_LOOKBACK_DAYS} days, newest first)
${sent.length ? sent.join("\n") : "(none available)"}

MEETINGS ${firstName.toUpperCase()} HELD (last ${REVIEW_LOOKBACK_DAYS} days)
${met.length ? met.join("\n") : "(none available)"}

Answer with JSON only, one entry per task, reason under 20 words:
{"items":[{"t":"T1","verdict":"keep","reason":"…","confidence":0.9},{"t":"T2","verdict":"duplicate","of":"T7","reason":"…","confidence":0.95}]}`;
}

export interface PlannedClose { a: ActionItem; v: ReviewItem; canonical?: ActionItem }

/** Which verdicts to apply: confident, consistent, and capped. Pure. */
export function planReview(
  tasks: ReadonlyArray<{ t: string; a: ActionItem }>,
  items: readonly ReviewItem[],
  opts: { min?: number; maxShare?: number } = {},
): PlannedClose[] {
  const byT = new Map(tasks.map((x) => [x.t, x.a]));
  const verdictOf = new Map<string, ReviewItem>();
  for (const v of items) if (byT.has(v.t) && !verdictOf.has(v.t)) verdictOf.set(v.t, v);
  const bar = (k: ReviewVerdictKind) => opts.min ?? REVIEW_MIN_BY_VERDICT[k] ?? REVIEW_MIN_CONFIDENCE;
  const closing = (v: ReviewItem | undefined) => !!v && v.verdict !== "keep" && v.confidence >= bar(v.verdict);
  const planned: PlannedClose[] = [];
  for (const [t, v] of verdictOf) {
    if (!closing(v)) continue;
    if (v.verdict === "duplicate") {
      // Only onto a task that stays open; never a pair closing each other.
      const canonical = v.of && v.of !== t ? byT.get(v.of) : undefined;
      if (!canonical || closing(verdictOf.get(v.of!))) continue;
      planned.push({ a: byT.get(t)!, v, canonical });
      continue;
    }
    planned.push({ a: byT.get(t)!, v });
  }
  const cap = Math.floor(tasks.length * (opts.maxShare ?? REVIEW_MAX_SHARE));
  return planned.sort((x, y) => y.v.confidence - x.v.confidence).slice(0, cap);
}

const ARCHIVED: Record<Exclude<ReviewVerdictKind, "keep">, NonNullable<ActionItem["archivedReason"]>> = {
  done: "done-elsewhere",
  duplicate: "duplicate",
  not_mine: "not-mine",
  not_a_task: "not-a-task",
  expired: "expired",
};
const LEAD: Record<Exclude<ReviewVerdictKind, "keep">, string> = {
  done: "looks done",
  duplicate: "a duplicate",
  not_mine: "someone else's",
  not_a_task: "not a task",
  expired: "the moment for this has passed",
};

/** The patch for one close. The note follows check-done's wording, so a reopen becomes a lesson. */
export function reviewPatch(p: PlannedClose, nowIso: string): Partial<ActionItem> {
  const kind = p.v.verdict as Exclude<ReviewVerdictKind, "keep">;
  const why = kind === "duplicate" && p.canonical ? `same as “${clip(p.canonical.text, 90)}”` : clip(p.v.reason, 160);
  const evidence = p.v.evidence ? ` (${clip(p.v.evidence, 120)})` : "";
  const note = `Closed by Basil on ${nowIso.slice(0, 10)}: ${LEAD[kind]}${why ? ` — ${why}` : ""}${evidence}. Reopen it if ${kind === "expired" ? "it still matters" : "not"}.`;
  return {
    status: "done",
    archivedReason: ARCHIVED[kind],
    closedByBasil: true,
    lastActivityAt: nowIso,
    notes: p.a.notes ? `${p.a.notes}\n${note}` : note,
  };
}

// ── The run ──────────────────────────────────────────────────────────────────

export type ReviewJudge = (prompt: string) => Promise<ReviewItem[]>;

/** Throws when Claude did not answer, or answered in a shape that cannot be read: nothing was judged. */
export function makeReviewJudge(username: string): ReviewJudge {
  return async (prompt) => {
    const { text } = await generateTextSafe({
      model: getTextModel("long"),
      // Thinking and the answer share this budget; 150 verdicts are ~6k tokens.
      maxOutputTokens: 24_000,
      system: "You tidy an executive's task list. You are conservative: when in doubt, keep.",
      prompt,
    }, "long", { username, feature: "actions:review" });
    const parsed = parseAndValidate(text, ReviewSchema, "[actions/review]");
    if (!parsed.ok) throw new Error(`[actions/review] the answer could not be read: ${parsed.error}`);
    return parsed.data.items;
  };
}

const FILE = "task-review.json";
/** Failed runs (other than billing refusals) allowed in one day before the review waits for tomorrow. */
const MAX_FAILED_RUNS = 3;
interface ReviewRecord {
  day: string;
  at: string;
  reviewed: number;
  closed: { id: string; text: string; verdict: ReviewVerdictKind; reason: string }[];
  /** Runs that failed today; absent on a run that finished. */
  failed?: number;
}

export interface ReviewResult {
  skipped?: "already-today" | "too-few" | "failed-today";
  reviewed: number;
  closed: { id: string; text: string; verdict: ReviewVerdictKind; reason: string }[];
}

export async function reviewOpenTasks(
  username: string,
  deps: {
    judge?: ReviewJudge;
    outbound?: OutboundEvent[];
    meetings?: ReviewMeeting[];
    now?: number;
    force?: boolean;
    /** Work out the verdicts without writing anything. */
    dryRun?: boolean;
    /**
     * Data handed in instead of read. A dry run against production must pass
     * all of these: listActions WRITES as it reads (its maintenance passes), and
     * a local run that could not read the user's identity once purged 163 of
     * their own actions (2026-11-25, restored).
     */
    actions?: ActionItem[];
    identity?: { names: string[] };
    settings?: { timezone?: string; name?: string } | null;
    absences?: string[];
    lessons?: DoneLesson[];
  } = {},
): Promise<ReviewResult & { planned?: PlannedClose[] }> {
  const now = deps.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const settings = deps.settings !== undefined ? deps.settings : await getSettings(username).catch((e) => { console.warn("[actions/review] settings unavailable:", e instanceof Error ? e.message : e); return null; });
  const tz = settings?.timezone || "Europe/London";
  const day = new Date(now).toLocaleDateString("en-CA", { timeZone: tz });
  let failedToday = 0;
  if (!deps.force && !deps.dryRun) {
    const last = await readUserStore<ReviewRecord | null>(username, FILE, null, { fresh: true }).catch(() => null); // ci-ok: unreadable record means review again
    if (last?.day === day) {
      if (!last.failed) return { skipped: "already-today", reviewed: 0, closed: [] };
      if (last.failed >= MAX_FAILED_RUNS) return { skipped: "failed-today", reviewed: 0, closed: [] };
      failedToday = last.failed;
    }
  }

  if (deps.dryRun && (!deps.actions || !deps.identity || !deps.outbound || !deps.meetings || deps.settings === undefined || !deps.absences || !deps.lessons)) {
    throw new Error("[actions/review] a dry run must be handed all its data (actions, identity, outbound, meetings, settings, absences, lessons)");
  }
  const [actions, identity] = await Promise.all([
    deps.actions ?? listActions(username, { fresh: true }),
    deps.identity ?? getSelfIdentity(username),
  ]);
  const open = actions.filter(reviewable).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const record = async (r: ReviewResult) => {
    if (deps.dryRun) return;
    await writeUserStore<ReviewRecord>(username, FILE, { day, at: nowIso, reviewed: r.reviewed, closed: r.closed });
  };
  if (open.length < 3) {
    const r: ReviewResult = { skipped: "too-few", reviewed: open.length, closed: [] };
    await record(r);
    return r;
  }

  const from = new Date(now - REVIEW_LOOKBACK_DAYS * 86_400_000).toLocaleDateString("en-CA", { timeZone: tz });
  const [outbound, meetings, cal, lessons] = await Promise.all([
    deps.outbound ?? loadOutbound(username, REVIEW_LOOKBACK_DAYS),
    deps.meetings ?? readCalendar(username, { from, to: day }, tz).then((c) => heldMeetings(c.events, nowIso)).catch((e) => {
      console.warn("[actions/review] calendar unavailable:", e instanceof Error ? e.message : e);
      return [] as ReviewMeeting[];
    }),
    deps.absences ? null : getWorkCalendar(username).catch((e) => { console.warn("[actions/review] working calendar unavailable:", e instanceof Error ? e.message : e); return null; }),
    deps.lessons ?? readDoneLessons(username).catch((e) => { console.warn("[actions/review] lessons unavailable:", e instanceof Error ? e.message : e); return [] as DoneLesson[]; }),
  ]);
  const firstName = (settings?.name || identity.names[0] || username).split(" ")[0];
  const absences = deps.absences ?? (cal?.away ?? [])
    .filter((p) => p.end >= from)
    .map((p) => `${p.start} to ${p.end}${p.label ? ` (${p.label})` : ""}`);
  const today = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(now);
  const recentOut = [...outbound].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200);
  const judge = deps.judge ?? makeReviewJudge(username);

  const planned: PlannedClose[] = [];
  try {
    for (let i = 0; i < open.length; i += PER_CALL) {
      const tasks = open.slice(i, i + PER_CALL).map((a, j) => ({ t: `T${j + 1}`, a }));
      const items = await judge(reviewPrompt({
        firstName, selfNames: identity.names, today, tasks, outbound: recentOut, meetings,
        absences, lessons: lessonsBlock(lessons, firstName, 10),
      }));
      planned.push(...planReview(tasks, items));
    }
  } catch (err) {
    // Nothing closes and the day stays open, so the next trigger (Today opening,
    // the next ingest) runs it again; only failures that may have cost money count.
    if (!deps.dryRun && !isBillingError(err)) {
      await writeUserStore<ReviewRecord>(username, FILE, { day, at: nowIso, reviewed: 0, closed: [], failed: failedToday + 1 }).catch((e) => {
        console.warn("[actions/review] could not record the failed run:", e instanceof Error ? e.message : e);
      });
    }
    throw err;
  }

  const closed = planned.map((p) => ({ id: p.a.id, text: p.a.text, verdict: p.v.verdict, reason: p.v.reason }));
  if (deps.dryRun) return { reviewed: open.length, closed, planned };
  if (planned.length) await bulkUpdateActions(username, planned.map((p) => ({ id: p.a.id, patch: reviewPatch(p, nowIso) })));
  const r: ReviewResult = { reviewed: open.length, closed };
  await record(r);
  console.log(`[actions/review] ${username}: reviewed ${open.length}, closed ${closed.length}`);
  return r;
}

/**
 * The scheduled run (after the morning ingest, and when Today opens): once a
 * day, one at a time per user. A second caller does not wait; it skips.
 */
export async function reviewOpenTasksDaily(username: string): Promise<ReviewResult | null> {
  try {
    return await withLock(`review:${username}`, () => reviewOpenTasks(username), { ttlMs: 240_000, retries: 1 });
  } catch (err) {
    console.warn("[actions/review] daily review skipped:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Meetings that have happened, with other people in them. */
export function heldMeetings(events: ReadonlyArray<{ summary: string; start: string; end: string; isAllDay: boolean; attendees: string[]; attendeeCount: number; myResponseStatus: string }>, nowIso: string): ReviewMeeting[] {
  return events
    .filter((e) => !e.isAllDay && e.attendeeCount > 0 && e.end <= nowIso && e.myResponseStatus !== "declined")
    .sort((a, b) => b.start.localeCompare(a.start))
    .slice(0, 150)
    .map((e) => ({ date: e.start.slice(0, 10), title: e.summary, with: e.attendees.slice(0, 6).map((n) => n.split(/[\s@]/)[0]) }));
}
