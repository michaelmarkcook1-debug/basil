/**
 * lib/actions/done-lessons-shape.ts — the pure half of done-lessons.ts:
 * what a lesson is, reading Basil's own close note back, and the prompt block.
 */

export interface DoneLesson {
  actionId: string;
  text: string;
  /** What Basil wrongly called it. */
  closedAs: "done" | "expired";
  /** Basil's reason at the time, from its close note. */
  reason: string;
  source?: string;
  reopenedAt: string;
}

/**
 * The reason from the newest "Closed by Basil on …" note:
 * "Closed by Basil on 2026-11-20: looks done — sent the deck (2, jane@acme.com). Reopen it if not."
 * → "looks done — sent the deck (2, jane@acme.com)".
 */
export function lastCloseReason(notes: string | undefined | null): string | null {
  const lines = (notes ?? "").split("\n").filter((l) => l.startsWith("Closed by Basil on "));
  const last = lines.at(-1);
  if (!last) return null;
  const m = /^Closed by Basil on [\d-]+:\s*(.*?)\.?\s*Reopen it if (?:not|it still matters)\.?\s*$/.exec(last);
  return (m?.[1] ?? last.replace(/^Closed by Basil on [\d-]+:\s*/, "")).trim() || null;
}

/** The newest mistakes as a prompt block for the judge. Empty when there are none. */
export function lessonsBlock(lessons: readonly DoneLesson[], firstName: string, max = 6): string {
  const recent = lessons.slice(0, max);
  if (!recent.length) return "";
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  return `Mistakes to learn from — you closed these and ${firstName} reopened them, so the reasoning was wrong:
${recent.map((l, i) => `${i + 1}. "${clip(l.text, 140)}" — you called it ${l.closedAs}${l.reason ? ` (${clip(l.reason, 140)})` : ""}.`).join("\n")}
If this item looks like one of those, or your reason would be the same kind, answer "open".

`;
}
