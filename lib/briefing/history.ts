/**
 * lib/briefing/history.ts — what each morning briefing put in front of the
 * user, kept for 60 days (audit 2026-11-24, Part 3 entry 19). Pure;
 * lib/briefing/history-store.ts keeps it.
 *
 * Every briefing was written from scratch, so Basil could not say "this has
 * been on your list for three weeks" — the most useful thing a chief of staff
 * says about a slipping item. Now the critical and follow-up lines of each
 * morning briefing are kept, and the next briefing is told which items keep
 * coming back and since when.
 *
 * Two lines are the same item when their significant words overlap enough
 * (Jaccard ≥ 0.5): "Reply to Jane about the Acme SOW" ≈ "Jane still needs the
 * Acme SOW reply".
 */

export interface BriefingDay { day: string; items: string[] }

export const KEEP_DAYS = 60;
const STOP = new Set("the a an and or to of for on in at by with about from your you his her their this that is are was be it as re fw fwd still needs need get send reply follow up today now".split(" "));

/** The bullet lines of a briefing section (markdown bullets / numbered / plain lines). */
export function itemsOf(section: string | null | undefined): string[] {
  return (section ?? "").split("\n")
    .map((l) => l.replace(/[*_`#>]/g, "").replace(/^\s*(?:[-•]|\d+[.)])\s*/, "").replace(/\s+/g, " ").trim())
    .filter((l) => l.length >= 12)
    .slice(0, 12);
}

export function wordsOf(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^a-z0-9' ]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)));
}

export function sameItem(a: string, b: string): boolean {
  const A = wordsOf(a), B = wordsOf(b);
  if (A.size < 2 || B.size < 2) return false;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both) >= 0.5;
}

/** Add today's items (replacing any earlier entry for today), keep 60 days, newest first. */
export function withDay(history: readonly BriefingDay[], day: string, items: readonly string[]): BriefingDay[] {
  const cutoff = new Date(Date.parse(`${day}T00:00:00Z`) - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
  return [{ day, items: [...items] }, ...history.filter((h) => h.day !== day && h.day >= cutoff)]
    .sort((a, b) => b.day.localeCompare(a.day));
}

export interface Recurring { text: string; since: string; days: number }

/**
 * Items from the most recent briefing before `today` that also appeared on at
 * least `minDays` distinct days — the ones that keep coming back.
 */
export function recurringItems(history: readonly BriefingDay[], today: string, minDays = 3): Recurring[] {
  const past = history.filter((h) => h.day < today).sort((a, b) => b.day.localeCompare(a.day));
  if (!past.length) return [];
  const out: Recurring[] = [];
  for (const item of past[0].items) {
    const seen = past.filter((h) => h.items.some((x) => sameItem(x, item)));
    if (seen.length < minDays) continue;
    out.push({ text: item, since: seen[seen.length - 1].day, days: seen.length });
  }
  return out.sort((a, b) => b.days - a.days).slice(0, 8);
}

export function recurringBlock(rec: readonly Recurring[], firstName: string): string {
  if (!rec.length) return "";
  return `## STILL ON THE LIST — items that keep coming back in ${firstName}'s briefings
${rec.map((r) => `- "${r.text}" — in ${r.days} briefings since ${r.since}`).join("\n")}
If one is still open today, say how long it has been on the list ("on your list since ${rec[0].since}") and suggest a way to close, delegate or drop it. If the sources show it was done, leave it out.`;
}
