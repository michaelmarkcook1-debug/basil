/**
 * lib/drafts/style.ts — the drafter learns how the user actually writes, from
 * what they did with Basil's drafts (audit 2026-11-24, item 5).
 *
 * Every time the user sends a message that started as a Basil draft, the pair
 * (Basil's draft, what was sent) is kept; a draft thrown away for a fresh one
 * is kept as rejected. From those:
 *   - per person: the newest examples of how the user rewrote drafts to them;
 *   - overall: measured habits — how much shorter they make drafts, how they
 *     open and sign off, phrases they always cut.
 * Both go into the next draft's prompt in place of the old fixed
 * "professional, direct and warm" line.
 *
 * Pure. lib/drafts/style-store.ts keeps the examples.
 */

export interface DraftExample {
  /** Lower-case address (email) or Slack ID / channel — who it went to. */
  to: string;
  toName?: string;
  channel: "email" | "slack";
  draft: string;
  /** What was sent. Absent when the draft was thrown away. */
  sent?: string;
  outcome: "unchanged" | "edited" | "rejected";
  at: string;
}

const norm = (s: string) => s.replace(/\r/g, "").replace(/[ \t]+$/gm, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
const words = (s: string) => (s.match(/\S+/g) ?? []).length;

/** unchanged / edited, ignoring whitespace. */
export function outcomeOf(draft: string, sent: string): DraftExample["outcome"] {
  return norm(draft) === norm(sent) ? "unchanged" : "edited";
}

/** The first line when it is a greeting ("Hi Jane,", "Hey team —"). */
export function greetingOf(text: string): string | null {
  const first = norm(text).split("\n")[0]?.trim() ?? "";
  return /^(hi|hey|hello|dear|morning|good (morning|afternoon|evening)|thanks|cheers)\b.{0,40}$/i.test(first) && first.length <= 40 ? first : null;
}

/** The sign-off block: the last one or two short lines ("Best,\nMichael" → "Best, Michael"). */
export function signOffOf(text: string): string | null {
  const lines = norm(text).split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const last = lines.slice(-2);
  const short = last.filter((l) => l.length <= 30);
  if (short.length === 0) return null;
  const block = (last[0].length <= 30 && /^(best|thanks|thank you|cheers|regards|kind regards|many thanks|speak soon|talk soon|all the best|warmly|ta|x+)[,.!]?$/i.test(last[0]) ? last : [last[1]]).join(" ");
  return block.length <= 40 ? block : null;
}

/** Sentences Basil wrote that the user deleted, across examples (phrases they never use). */
export function cutPhrases(examples: readonly DraftExample[], min = 2): string[] {
  const counts = new Map<string, number>();
  for (const e of examples) {
    if (e.outcome !== "edited" || !e.sent) continue;
    const sent = e.sent.toLowerCase();
    const seen = new Set<string>();
    for (const s of e.draft.split(/(?<=[.!?])\s+|\n+/)) {
      const k = s.trim().toLowerCase().replace(/[^a-z' ]/g, "").replace(/\s+/g, " ").trim();
      if (k.split(" ").length < 3 || k.split(" ").length > 12 || seen.has(k)) continue;
      seen.add(k);
      if (!sent.includes(k.split(" ").slice(0, 3).join(" "))) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  return [...counts].filter(([, n]) => n >= min).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
}

export interface StyleHabits {
  samples: number;
  keptAsIs: number;
  rejected: number;
  /** Sent length ÷ draft length, median, over edited drafts. */
  lengthRatio?: number;
  greetings: string[];
  signOffs: string[];
  cut: string[];
}

export function habitsFrom(examples: readonly DraftExample[]): StyleHabits {
  const edited = examples.filter((e) => e.outcome === "edited" && e.sent);
  const ratios = edited.map((e) => words(e.sent!) / Math.max(1, words(e.draft))).sort((a, b) => a - b);
  const sentTexts = examples.filter((e) => e.sent).map((e) => e.sent!);
  const top = (xs: Array<string | null>) => {
    const c = new Map<string, number>();
    for (const x of xs) if (x) { const k = x.replace(/\b[A-Z][a-z]+\b(?=[,!.\s]*$)/, "{name}"); c.set(k, (c.get(k) ?? 0) + 1); }
    return [...c].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k);
  };
  return {
    samples: examples.length,
    keptAsIs: examples.filter((e) => e.outcome === "unchanged").length,
    rejected: examples.filter((e) => e.outcome === "rejected").length,
    ...(ratios.length >= 3 ? { lengthRatio: Math.round(ratios[Math.floor(ratios.length / 2)] * 100) / 100 } : {}),
    greetings: top(sentTexts.map(greetingOf)),
    signOffs: top(sentTexts.map(signOffOf)),
    cut: cutPhrases(examples),
  };
}

const clip = (s: string, n: number) => { const t = norm(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/**
 * The drafting-style block for a prompt: how the user writes in general and
 * to this person. Empty when Basil has seen none of their sends yet (the
 * caller then keeps its default tone line).
 */
export function styleBlock(examples: readonly DraftExample[], to: { address?: string; name?: string }, firstName: string, opts: { perPerson?: number } = {}): string {
  if (!examples.length) return "";
  const h = habitsFrom(examples);
  const lines: string[] = [];
  if (h.lengthRatio !== undefined && h.lengthRatio < 0.85) lines.push(`${firstName} cuts Basil's drafts to about ${Math.round(h.lengthRatio * 100)}% of their length — write that short.`);
  if (h.lengthRatio !== undefined && h.lengthRatio > 1.2) lines.push(`${firstName} usually adds to Basil's drafts (about ${Math.round(h.lengthRatio * 100)}% of the length) — give fuller answers.`);
  if (h.greetings.length) lines.push(`Opens with: ${h.greetings.map((g) => `"${g}"`).join(" or ")}.`);
  if (h.signOffs.length) lines.push(`Signs off: ${h.signOffs.map((g) => `"${g}"`).join(" or ")}.`);
  if (h.cut.length) lines.push(`Always deletes lines like: ${h.cut.map((c) => `"${c}"`).join("; ")} — don't write them.`);
  if (h.rejected >= 2 && h.rejected / h.samples > 0.3) lines.push(`${firstName} throws away many drafts outright — be specific to the message, never generic.`);

  const addr = to.address?.trim().toLowerCase();
  const nameKey = to.name?.trim().toLowerCase();
  const mine = examples.filter((e) => e.outcome !== "unchanged" && ((addr && e.to === addr) || (!addr && nameKey && e.toName?.toLowerCase() === nameKey)))
    .slice(0, opts.perPerson ?? 3);
  const person = mine.length
    ? `\nHow ${firstName} rewrote earlier drafts to ${to.name || to.address} (match this, not Basil's version):\n${mine.map((e) =>
      e.outcome === "rejected"
        ? `- Threw away: "${clip(e.draft, 220)}"`
        : `- Basil wrote: "${clip(e.draft, 220)}"\n  ${firstName} sent: "${clip(e.sent ?? "", 260)}"`).join("\n")}`
    : "";
  if (!lines.length && !person) return "";
  return `## How ${firstName} actually writes (learned from ${h.samples} draft${h.samples === 1 ? "" : "s"} ${firstName} sent, edited or threw away)\n${lines.map((l) => `- ${l}`).join("\n")}${person}`;
}
