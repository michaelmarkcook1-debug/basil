import "server-only";

import type { Memory } from "@/lib/memory/types";
import type { ActionItem } from "@/lib/types/action";

/**
 * lib/actions/follow-up-rules.ts
 *
 * Standing follow-up rules, applied automatically by the daily ingest.
 *
 * The chat side already turns "follow up with demo attendees two weeks after
 * each demo" into dated actions for the demos VISIBLE at that moment, and saves
 * the rule to memory. This module closes the other half: when a NEW matching
 * event lands on the calendar later, the daily poll-ingest cron applies the
 * stored rule without the user having to re-ask.
 *
 * PURE functions (no I/O) so the matching and idempotency rules are testable —
 * the same design as resolve-calendar.ts, and for the same reason: creating a
 * wrong or duplicate commitment erodes trust in the whole tracker.
 */

export interface FollowUpRule {
  /** Lowercased phrase that must appear in the event summary (e.g. "demo"). */
  keyword: string;
  /** Days after the event's date the follow-up falls due. */
  offsetDays: number;
  /** The memory this rule came from (for logging / future management UI). */
  memoryId: string;
}

/** Minimal event shape needed here (subset of CalendarEvent). */
export interface RuleEvent {
  summary: string;
  /** ISO datetime; only the yyyy-mm-dd part is used. */
  start: string;
  attendees: string[];
}

export interface FollowUpCandidate {
  text: string;
  dueDate: string;
  rule: FollowUpRule;
  eventSummary: string;
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

function toDays(amountRaw: string, unit: string): number | null {
  const n = /^\d+$/.test(amountRaw) ? parseInt(amountRaw, 10) : WORD_NUMBERS[amountRaw.toLowerCase()];
  if (!n || n <= 0) return null;
  const u = unit.toLowerCase();
  if (u.startsWith("day")) return n;
  if (u.startsWith("week")) return n * 7;
  if (u.startsWith("month")) return n * 30;
  return null;
}

/**
 * Canonical form the assistant is instructed to save:
 *   FOLLOW-UP RULE: match "demo" — follow up with attendees — offset 14 days
 */
const CANONICAL_RE = /FOLLOW-UP RULE:\s*match\s*"([^"]{2,60})"[\s\S]{0,120}?offset\s*(\d+)\s*days?/i;

/**
 * Loose fallback for rules saved as natural prose before the canonical format
 * existed (e.g. "Michael wants to follow up with demo attendees two weeks
 * after each demo").
 */
const LOOSE_RE = /follow[\s-]?up[\s\S]{0,80}?\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(days?|weeks?|months?)\s+after\s+(?:each|every|all|any|a|the)\s+([a-z][a-z0-9 -]{2,40})/i;

/** Trailing generic words that aren't the discriminating keyword. */
const TRAILING_NOISE = /\s*(call|meeting|session|event|invite)s?\s*$/i;

/**
 * Extract standing follow-up rules from stored memories.
 * One rule per memory (first match wins); malformed content simply yields none.
 */
export function extractFollowUpRules(memories: Memory[]): FollowUpRule[] {
  const rules: FollowUpRule[] = [];
  for (const m of memories) {
    const content = m.content ?? "";
    const canonical = CANONICAL_RE.exec(content);
    if (canonical) {
      const offsetDays = parseInt(canonical[2], 10);
      if (offsetDays > 0) {
        rules.push({ keyword: canonical[1].trim().toLowerCase(), offsetDays, memoryId: m.id });
      }
      continue;
    }
    const loose = LOOSE_RE.exec(content);
    if (loose) {
      const offsetDays = toDays(loose[1], loose[2]);
      const keyword = loose[3].replace(TRAILING_NOISE, "").trim().toLowerCase();
      if (offsetDays && keyword.length >= 3) {
        rules.push({ keyword, offsetDays, memoryId: m.id });
      }
    }
  }
  return rules;
}

/** yyyy-mm-dd + N days, computed on pure DATE PARTS via UTC. Never route this
 *  through a local-midnight Date + toISOString() — that shifted BST dates back
 *  a day once before in this repo. */
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

/** Loose-but-stable normalisation for idempotency checks. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Apply rules to calendar events, yielding follow-up candidates.
 *
 * Guarantees that keep the tracker trustworthy:
 * - Only real meetings: an event with no other attendees (focus blocks, lunch)
 *   never generates a follow-up — prepping you to chase nobody is noise.
 * - Deterministic text (summary + event date, NO attendee names — those can
 *   change between cron runs and would defeat dedupe), so re-runs are
 *   idempotent against `existingActions` REGARDLESS of status: a follow-up the
 *   user already completed must not resurrect on the next cron.
 * - Stale follow-ups are skipped: if the due date passed more than
 *   `graceDays` ago, the moment is gone — creating it now is backlog spam.
 */
export function applyFollowUpRules(
  rules: FollowUpRule[],
  events: RuleEvent[],
  existingActions: ActionItem[],
  todayStr: string,
  graceDays = 2,
): FollowUpCandidate[] {
  if (rules.length === 0 || events.length === 0) return [];

  const existing = new Set(existingActions.map((a) => normalize(a.text)));
  const staleFloor = addDays(todayStr, -graceDays);
  const out: FollowUpCandidate[] = [];
  const seenThisRun = new Set<string>();

  for (const event of events) {
    const day = (event.start || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if ((event.attendees ?? []).length === 0) continue;
    const summaryLower = (event.summary || "").toLowerCase();

    for (const rule of rules) {
      if (!summaryLower.includes(rule.keyword)) continue;
      const dueDate = addDays(day, rule.offsetDays);
      if (dueDate < staleFloor) continue;

      const text = `Follow up with attendees of "${event.summary.trim()}" (${day})`;
      const key = normalize(text);
      if (existing.has(key) || seenThisRun.has(key)) continue;
      seenThisRun.add(key);
      out.push({ text, dueDate, rule, eventSummary: event.summary });
    }
  }
  return out;
}
