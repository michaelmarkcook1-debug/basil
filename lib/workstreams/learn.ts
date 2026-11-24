/**
 * lib/workstreams/learn.ts — Basil learning how the user files things.
 *
 * Michael, 2026-11-24: "Basil needs to learn from user categorization of
 * tasks to then be able to automate the automatic allocation of these tasks
 * moving forward."
 *
 * Three ways it learns, all from the user's own filings (never Basil's guesses):
 *
 *   1. Patterns become rules. When the user files things from the same sender,
 *      project, Slack channel or company domain into the same workstream —
 *      twice for a sender or project, three times for a channel or domain —
 *      and never anywhere else, Basil makes that a rule. If the user later
 *      files one somewhere else, the learned rule goes. Rules the user made
 *      themselves are never touched, and a learned rule the user deleted is
 *      not learned again.
 *   2. Near-identical items reuse a filing. A new item whose words are nearly
 *      the same as one the user filed (a recurring "Weekly pipeline review",
 *      "Invoice #123 from X") gets that workstream, with no model call.
 *   3. The classifier sees the user's MOST SIMILAR filings as examples, not
 *      just the most recent ones.
 *
 * And it keeps score: every time the user opens a label and picks, Basil
 * records what it had guessed, so Settings can say how often it is right.
 *
 * Pure.
 */

import type { Workstream, WorkstreamBy, WorkstreamRule } from "@/lib/workstreams/types";

/** What a filed item was, for spotting patterns. All lower-cased. */
export interface Features {
  sender?: string;
  channel?: string;
  project?: string;
  source?: string;
}

/** A user filing as learning sees it. */
export interface Filing {
  w: Workstream;
  t?: string;
  f?: Features;
  /** What Basil had before the user chose (absent when it had nothing). */
  was?: { w: Workstream | null; by: Exclude<WorkstreamBy, "user"> };
  at: string;
}

type LearnField = Extract<WorkstreamRule["field"], "sender" | "domain" | "channel" | "project">;

/** Filings that must agree before a pattern becomes a rule. */
export const LEARN_AT: Record<LearnField, number> = { sender: 2, project: 2, channel: 3, domain: 3 };

const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "live.co.uk", "msn.com",
  "yahoo.com", "yahoo.co.uk", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com",
]);

export const ruleId = (field: string, value: string) => `${field}:${value}`;

function valueOf(field: LearnField, f: Features | undefined, ownDomains: ReadonlySet<string>): string | undefined {
  if (!f) return undefined;
  if (field === "sender") return f.sender || undefined;
  if (field === "channel") return f.channel?.replace(/^#/, "") || undefined;
  if (field === "project") return f.project || undefined;
  const at = f.sender?.lastIndexOf("@") ?? -1;
  const d = at > 0 ? f.sender!.slice(at + 1) : undefined;
  return d && !FREE_MAIL.has(d) && !ownDomains.has(d) ? d : undefined;
}

export interface LearnResult {
  rules: WorkstreamRule[];
  added: WorkstreamRule[];
  removed: WorkstreamRule[];
}

/**
 * The rules after learning from every user filing. `suppressed` holds
 * "field:value" pairs the user deleted, which are never re-learned.
 */
export function learnRules(
  filings: readonly Filing[],
  rules: readonly WorkstreamRule[],
  opts: { suppressed?: readonly string[]; ownDomains?: readonly string[]; now?: string; newId?: () => string } = {},
): LearnResult {
  const own = new Set((opts.ownDomains ?? []).map((d) => d.toLowerCase()));
  const suppressed = new Set(opts.suppressed ?? []);
  const now = opts.now ?? new Date().toISOString();
  let n = 0;
  const newId = opts.newId ?? (() => `wsl-${Date.now().toString(36)}${(n++).toString(36)}`);

  // Tally filings per (field, value) → workstream counts.
  const tally = new Map<string, { field: LearnField; value: string; counts: Map<Workstream, number> }>();
  for (const fl of filings) {
    for (const field of Object.keys(LEARN_AT) as LearnField[]) {
      const value = valueOf(field, fl.f, own);
      if (!value) continue;
      const k = ruleId(field, value);
      const e = tally.get(k) ?? { field, value, counts: new Map() };
      e.counts.set(fl.w, (e.counts.get(fl.w) ?? 0) + 1);
      tally.set(k, e);
    }
  }

  const userMade = new Set(rules.filter((r) => !r.learned).map((r) => ruleId(r.field, r.value)));
  const next: WorkstreamRule[] = [];
  const removed: WorkstreamRule[] = [];
  const added: WorkstreamRule[] = [];

  // Existing learned rules: keep while the pattern still holds unanimously.
  const keptLearned = new Set<string>();
  for (const r of rules) {
    if (!r.learned) { next.push(r); continue; }
    const k = ruleId(r.field, r.value);
    const e = tally.get(k);
    const unanimous = e && e.counts.size === 1 && e.counts.has(r.workstream);
    if (unanimous && !suppressed.has(k) && !userMade.has(k)) {
      next.push({ ...r, learned: { ...r.learned, from: e!.counts.get(r.workstream)! } });
      keptLearned.add(k);
    } else {
      removed.push(r);
    }
  }

  // New patterns.
  for (const [k, e] of tally) {
    if (keptLearned.has(k) || userMade.has(k) || suppressed.has(k)) continue;
    if (e.counts.size !== 1) continue;
    const [[w, count]] = [...e.counts];
    if (count < LEARN_AT[e.field]) continue;
    const rule: WorkstreamRule = { id: newId(), field: e.field, value: e.value, workstream: w, createdAt: now, learned: { from: count } };
    next.push(rule);
    added.push(rule);
  }
  return { rules: next, added, removed };
}

// ── Similarity ───────────────────────────────────────────────────────────────

const STOP = new Set("the a an and or of to for in on at by with from re fwd fw is are be this that it you your we our i me my please can could will just about".split(" "));

/** Content words, numbers stripped (so "Invoice #123" and "Invoice #456" match). */
export function words(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^\p{L}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );
}

export function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Above this, an item is "the same kind of thing" as one the user filed. */
export const SAME_AS = 0.75;
/** Fewer words than this and similarity means little ("Call", "Follow up"). */
const MIN_WORDS = 3;

/**
 * The workstream of the user's filing that this text nearly repeats, when all
 * such filings agree. Undefined when there is none or they disagree.
 */
export function nearestFiling(text: string, filings: ReadonlyArray<{ w: Workstream; t?: string }>): Workstream | undefined {
  const mine = words(text);
  if (mine.size < MIN_WORDS) return undefined;
  const hits = new Set<Workstream>();
  for (const f of filings) {
    if (!f.t) continue;
    const theirs = words(f.t);
    if (theirs.size >= MIN_WORDS && similarity(mine, theirs) >= SAME_AS) hits.add(f.w);
  }
  return hits.size === 1 ? [...hits][0] : undefined;
}

/** The user's filings most like these texts, best first, for the classifier's examples. */
export function similarExamples(
  texts: readonly string[],
  filings: ReadonlyArray<{ w: Workstream; t?: string; at: string }>,
  limit = 12,
): Array<{ t: string; w: Workstream }> {
  const targets = texts.map(words);
  const scored = filings
    .filter((f): f is { w: Workstream; t: string; at: string } => !!f.t)
    .map((f) => {
      const fw = words(f.t);
      return { f, score: Math.max(0, ...targets.map((t) => similarity(t, fw))) };
    });
  // Similar ones first; then the most recent, so a new user still gets examples.
  scored.sort((a, b) => b.score - a.score || b.f.at.localeCompare(a.f.at));
  return scored.slice(0, limit).map(({ f }) => ({ t: f.t, w: f.w }));
}

// ── Keeping score ────────────────────────────────────────────────────────────

export interface LearningScore {
  /** Times the user opened a label Basil had set and picked. */
  checked: number;
  /** Of those, how many Basil already had right. */
  right: number;
  /** checked > 0 ? right / checked : null */
  accuracy: number | null;
  /** The same, over the last 30 checks: is it getting better? */
  recentAccuracy: number | null;
  /** Total user filings Basil learns from. */
  filings: number;
}

export function scoreOf(filings: readonly Filing[]): LearningScore {
  const checked = filings.filter((f) => f.was && f.was.w !== undefined).sort((a, b) => a.at.localeCompare(b.at));
  const right = checked.filter((f) => f.was!.w === f.w).length;
  const recent = checked.slice(-30);
  const recentRight = recent.filter((f) => f.was!.w === f.w).length;
  return {
    checked: checked.length,
    right,
    accuracy: checked.length ? Math.round((right / checked.length) * 100) / 100 : null,
    recentAccuracy: recent.length >= 10 ? Math.round((recentRight / recent.length) * 100) / 100 : null,
    filings: filings.length,
  };
}
