/**
 * lib/contacts/relationship-signals.ts — the facts behind a relationship read.
 *
 * Tone used to be judged from word choice against "normal professional norms",
 * which marks every naturally terse or direct writer as cooling. The evidence
 * (docs/tone-sentiment-review-2026-10-21.md) says two things instead:
 *   1. judge each person against their OWN baseline, not a population norm;
 *   2. the best-supported signals are not words at all — reply latency, who
 *      starts threads, and message length, each relative to that person's habit
 *      (Kalman et al. 2006; Navarro et al. 2017).
 *
 * This module computes those facts from the interactions Basil already has.
 * It is pure: no I/O, no model. The read prompt gets the result as context,
 * and the profile card shows it as plain facts ("replies in 2h, usually 6h").
 */

export interface Msg { date: string; mine: boolean; text: string; source: string }

/** One person's usual way of writing to the user, over the long window. */
export interface Baseline {
  /** Messages the baseline rests on (theirs only). */
  n: number;
  /** Median words per message from them. */
  medianWords: number;
  /** Share of their messages that are ≤ 6 words. */
  shortShare: number;
  /** Median hours they take to reply to the user (undefined: never saw a reply). */
  medianReplyHours?: number;
  /** Median gap between their messages, in days. */
  medianGapDays?: number;
  /** Share of threads they started (vs the user). */
  initiationShare?: number;
}

/** The same measures over the recent window, each compared with the baseline. */
export interface RecentSignals {
  n: number;
  medianWords: number;
  medianReplyHours?: number;
  initiationShare?: number;
  /** Days since their last message. */
  daysSinceLast: number;
  /** Their last message gap as a multiple of their usual gap (Navarro: > 8 is decay territory). */
  gapRatio?: number;
  /** Their recent reply time as a multiple of their usual (Kalman: > 10 is silence territory). */
  replyRatio?: number;
  /** Recent length as a multiple of their usual. */
  lengthRatio?: number;
}

export type Confidence = "early" | "normal" | "grounded";

const median = (xs: number[]): number | undefined => {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;
const hours = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 3_600_000;

/** Reply times: for each of the user's messages, how long until their next message. */
function replyHours(sorted: Msg[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (!sorted[i].mine) continue;
    const next = sorted.slice(i + 1).find((m) => !m.mine);
    if (!next) break;
    const h = hours(sorted[i].date, next.date);
    // A reply is what follows within the same thread. Past 48 hours the next
    // message is a new thread (see `initiations`), not a slow reply — counting
    // it would make every regular correspondent look slow.
    if (h >= 0 && h < 48) out.push(h);
  }
  return out;
}

/** Who opened each thread: a message after a gap of 2+ days starts a new one. */
function initiations(sorted: Msg[]): { theirs: number; total: number } {
  let theirs = 0, total = 0;
  for (let i = 0; i < sorted.length; i++) {
    const gap = i === 0 ? Infinity : hours(sorted[i - 1].date, sorted[i].date);
    if (gap >= 48) { total++; if (!sorted[i].mine) theirs++; }
  }
  return { theirs, total };
}

/** Oldest first. */
const chrono = (msgs: Msg[]) => [...msgs].sort((a, b) => a.date.localeCompare(b.date));

export function baselineOf(msgs: Msg[]): Baseline {
  const sorted = chrono(msgs);
  const theirs = sorted.filter((m) => !m.mine);
  const lens = theirs.map((m) => words(m.text));
  const gaps: number[] = [];
  for (let i = 1; i < theirs.length; i++) gaps.push(hours(theirs[i - 1].date, theirs[i].date) / 24);
  const init = initiations(sorted);
  return {
    n: theirs.length,
    medianWords: median(lens) ?? 0,
    shortShare: lens.length ? lens.filter((w) => w <= 6).length / lens.length : 0,
    medianReplyHours: median(replyHours(sorted)),
    medianGapDays: median(gaps),
    initiationShare: init.total >= 2 ? init.theirs / init.total : undefined,
  };
}

export function recentSignals(msgs: Msg[], base: Baseline, now = Date.now()): RecentSignals {
  const sorted = chrono(msgs);
  const theirs = sorted.filter((m) => !m.mine);
  const last = theirs.at(-1);
  const daysSinceLast = last ? (now - Date.parse(last.date)) / 86_400_000 : Infinity;
  const medianWords = median(theirs.map((m) => words(m.text))) ?? 0;
  const medianReplyHours = median(replyHours(sorted));
  const init = initiations(sorted);
  const ratio = (a: number | undefined, b: number | undefined) =>
    a !== undefined && b !== undefined && b > 0 ? a / b : undefined;
  return {
    n: theirs.length,
    medianWords,
    medianReplyHours,
    initiationShare: init.total >= 2 ? init.theirs / init.total : undefined,
    daysSinceLast,
    gapRatio: base.medianGapDays && base.medianGapDays > 0 && last ? daysSinceLast / base.medianGapDays : undefined,
    replyRatio: ratio(medianReplyHours, base.medianReplyHours),
    lengthRatio: base.medianWords > 0 ? medianWords / base.medianWords : undefined,
  };
}

/**
 * How much to trust a read. Fewer than 5 messages, or all of them inside one
 * week, is a glimpse — shown grey, with no trend. 15+ across 2+ weeks is grounded.
 */
export function confidenceOf(msgs: Msg[]): Confidence {
  const theirs = msgs.filter((m) => !m.mine);
  if (theirs.length < 5) return "early";
  const dates = theirs.map((m) => Date.parse(m.date));
  const spanDays = (Math.max(...dates) - Math.min(...dates)) / 86_400_000;
  if (spanDays < 7) return "early";
  return theirs.length >= 15 && spanDays >= 14 ? "grounded" : "normal";
}

const fmtH = (h: number) => (h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`);

/**
 * Plain-English facts for the prompt and the card. Only says something when
 * there is a baseline to compare against; never guesses.
 */
export function describeSignals(base: Baseline, recent: RecentSignals): string[] {
  const out: string[] = [];
  if (base.n < 5) return out;
  out.push(`Usually writes ${Math.round(base.medianWords)} words a message${base.shortShare >= 0.5 ? " (mostly one-liners)" : ""}.`);
  if (recent.lengthRatio !== undefined && recent.n >= 3) {
    if (recent.lengthRatio <= 0.5) out.push(`Recent messages are about half their usual length (${Math.round(recent.medianWords)} words).`);
    else if (recent.lengthRatio >= 1.8) out.push(`Recent messages are longer than usual (${Math.round(recent.medianWords)} words).`);
  }
  if (base.medianReplyHours !== undefined) {
    const now = recent.medianReplyHours;
    if (now !== undefined && recent.replyRatio !== undefined) {
      if (recent.replyRatio >= 3) out.push(`Replying in ${fmtH(now)}, usually ${fmtH(base.medianReplyHours)}.`);
      else if (recent.replyRatio <= 0.4) out.push(`Replying faster than usual: ${fmtH(now)}, usually ${fmtH(base.medianReplyHours)}.`);
      else out.push(`Replies in about ${fmtH(now)}, as usual.`);
    } else out.push(`Usually replies in ${fmtH(base.medianReplyHours)}.`);
  }
  if (recent.gapRatio !== undefined && recent.gapRatio >= 8 && Number.isFinite(recent.daysSinceLast)) {
    out.push(`Quiet for ${Math.round(recent.daysSinceLast)} days, far longer than their usual gap of ${base.medianGapDays!.toFixed(1)} days.`);
  }
  if (base.initiationShare !== undefined && recent.initiationShare !== undefined) {
    const d = recent.initiationShare - base.initiationShare;
    if (d <= -0.35) out.push("Starting fewer conversations than they used to.");
    else if (d >= 0.35) out.push("Starting more conversations than they used to.");
  }
  return out;
}
