/**
 * lib/people/carry-over.ts — who the conversation is about (audit 2026-11-24,
 * Part 3 entry 9).
 *
 * Ask Basil loaded memories and people for the latest message only, so after
 * "what's going on with Jane Doe?" the follow-up "and what does she want?"
 * loaded nothing about Jane. This finds the people named in the recent turns
 * (user's and Basil's) so they carry into the next message's context, when
 * that message names nobody itself.
 *
 * Full names only (first + last), matched on word boundaries, so a common
 * first name or word never drags in a stranger. Pure.
 */
import type { Person } from "@/lib/people/directory";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Full names (two or more words, 5+ chars) of known people that appear in `text`. */
export function fullNamesIn(text: string, people: readonly Person[], max = 6): string[] {
  const hay = ` ${text.toLowerCase().replace(/\s+/g, " ")} `;
  const found: Array<{ name: string; at: number }> = [];
  const seen = new Set<string>();
  for (const p of people) {
    for (const n of p.names) {
      const k = n.trim().toLowerCase().replace(/\s+/g, " ");
      if (k.length < 5 || !k.includes(" ") || seen.has(k)) continue;
      if (!hay.includes(k)) continue;
      const m = new RegExp(`[^a-z0-9]${esc(k)}[^a-z0-9]`).exec(hay);
      if (!m) continue;
      seen.add(k);
      found.push({ name: p.name, at: m.index });
      break;
    }
  }
  const names = [...new Set(found.sort((a, b) => b.at - a.at).map((f) => f.name))];
  return names.slice(0, max);
}

/**
 * People to carry into this turn: none when the latest message names someone
 * itself (the conversation has moved on); otherwise the people named in the
 * earlier turns, newest turn first, at most `max`.
 */
export function carryOverPeople(latest: string, earlierNewestFirst: readonly string[], people: readonly Person[], max = 3): string[] {
  if (!people.length || fullNamesIn(latest, people, 1).length) return [];
  const out: string[] = [];
  for (const turn of earlierNewestFirst) {
    for (const n of fullNamesIn(turn, people)) if (!out.includes(n)) out.push(n);
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}
