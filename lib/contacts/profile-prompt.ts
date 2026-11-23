/**
 * lib/contacts/profile-prompt.ts — what a personality profile is built from.
 *
 * Pure: assembles the evidence blocks and the prompt, so the shape of a profile
 * read is testable without Gmail, Slack or a model. The route gathers; this
 * decides what the model sees.
 *
 * Three rules, from docs/personality-profiles-review-2026-10-21.md:
 *   1. The user's own notes are the most reliable input and are never
 *      discarded: they are shown to the model as stated facts, and stored
 *      separately so they survive every regeneration.
 *   2. Regeneration is additive. The previous profile goes in, marked as such;
 *      the model keeps what still holds, revises what new evidence contradicts,
 *      and says what changed.
 *   3. Observed habits only, never trait types (DISC, MBTI, Big Five): those
 *      are unreliable from text and are the category regulators treat as
 *      profiling.
 */

import type { Baseline } from "@/lib/contacts/relationship-signals";
import { evidenceBlocks, NOT_ENOUGH, type EvidenceItem } from "@/lib/contacts/profile-evidence";

export interface PriorProfile {
  personality?: string;
  whatMakesThemTick?: string;
  watchOut?: string;
  generatedAt?: string;
}

export interface ProfileInputs {
  name: string;
  email?: string;
  phone?: string;
  directory: "work" | "personal";
  /** The user's first name, for the prompt's voice. */
  selfFirst: string;
  prior?: PriorProfile;
  /** Numbered evidence (lib/contacts/profile-evidence numberEvidence). */
  items: EvidenceItem[];
  /** Claims the user marked wrong on earlier drafts — never to be repeated. */
  rejected?: string[];
}

// ── Whose message is it? ─────────────────────────────────────────────────────
//
// Until 2026-11-23 evidence was gathered by substring: a contact called "Guy"
// pulled in every Slack message saying "you guys" and every Zoom summary
// mentioning "the guy from Atos". Whole words only, an exact address where one
// is known, and a bare first name only where it names the AUTHOR — never as a
// mention in someone else's text, where common first names (Guy, Will, Mark,
// Grace) are ordinary words.

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRe = (s: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(s)}($|[^\\p{L}\\p{N}])`, "iu");

export interface PersonMatcher {
  /** An email sent by this person. */
  sentEmail(m: { from: string; fromEmail?: string }): boolean;
  /** A chat message written by this person (Slack/Teams display name). */
  authored(author: string): boolean;
  /** Text that names this person unambiguously (full name only). */
  mentions(text: string): boolean;
}

export function personMatcher(name: string, email?: string): PersonMatcher {
  const full = name.trim().toLowerCase().replace(/\s+/g, " ");
  const first = full.split(" ")[0] ?? "";
  const multi = full.includes(" ");
  const addr = email?.trim().toLowerCase();
  const fullRe = full ? wordRe(full) : null;
  const firstRe = first.length >= 3 ? wordRe(first) : null;
  const display = (from: string) => from.replace(/<[^>]*>/g, " ");
  return {
    sentEmail(m) {
      const fromEmail = (m.fromEmail ?? "").toLowerCase();
      if (addr && (fromEmail === addr || m.from.toLowerCase().includes(`<${addr}>`))) return true;
      if (addr && fromEmail) return multi && !!fullRe?.test(display(m.from)); // a known, different address: full name only
      return !!fullRe?.test(display(m.from)) || (!addr && !!firstRe?.test(display(m.from)));
    },
    authored(author) {
      return !!fullRe?.test(author) || !!firstRe?.test(author);
    },
    mentions(text) {
      return multi && !!fullRe?.test(text);
    },
  };
}

/** Messages that mention or come from the person (notes and measurements excluded). */
export function signalCount(items: readonly EvidenceItem[]): number {
  return items.filter((e) => e.by === "them" || e.by === "others").length;
}

/** The measured habits as plain lines — they become [H#] evidence. Exported for tests. */
export function habitLines(base: Baseline | undefined, facts: string[] | undefined): string[] {
  if (!base || base.n < 5) return [];
  return [
    `Over the last 90 days: ${base.n} messages from them; median ${Math.round(base.medianWords)} words a message${base.shortShare >= 0.5 ? " (mostly one-liners)" : ""}.`,
    base.medianReplyHours !== undefined ? `Usually replies within ${base.medianReplyHours < 1 ? "the hour" : base.medianReplyHours < 48 ? `${Math.round(base.medianReplyHours)} hours` : `${Math.round(base.medianReplyHours / 24)} days`}.` : null,
    base.initiationShare !== undefined ? `Starts ${Math.round(base.initiationShare * 100)}% of the conversations between you.` : null,
    ...(facts ?? []),
  ].filter((l): l is string => !!l);
}

/** Exported for tests. */
export function buildProfilePrompt(i: ProfileInputs): string {
  const n = signalCount(i.items);
  const stated = i.items.some((e) => e.by === "stated");
  const priorBlock = i.prior && (i.prior.personality || i.prior.whatMakesThemTick || i.prior.watchOut)
    ? `## THE CURRENT PROFILE (written ${i.prior.generatedAt?.slice(0, 10) ?? "earlier"}) — revise, do not restart
- personality: ${i.prior.personality ?? "(none)"}
- whatMakesThemTick: ${i.prior.whatMakesThemTick ?? "(none)"}
- watchOut: ${i.prior.watchOut ?? "(none)"}
Keep every line that the evidence below still supports, with its citations. A line nothing below supports any more is dropped; say so in "changes". The current profile is NOT evidence and cannot be cited. Never drop a stated fact from ${i.selfFirst}.

`
    : "";

  return `Write or update a personality profile for one of ${i.selfFirst}'s contacts. Match the style of hand-written chief-of-staff notes: specific, observational, grounded in evidence. No fluff.

## CONTACT
Name: ${i.name}
${i.email ? `Email: ${i.email}\n` : ""}${i.phone ? `Phone: ${i.phone}\n` : ""}Directory: ${i.directory} ${i.directory === "personal" ? "(friend / family — not a colleague)" : "(colleague, investor, client, or vendor)"}

${priorBlock}${i.rejected?.length ? `## ${i.selfFirst.toUpperCase()} SAID THESE WERE WRONG — do not repeat them, or anything that means the same\n${i.rejected.map((r) => `- "${r}"`).join("\n")}\n\n` : ""}${evidenceBlocks(i.items, i.selfFirst, i.name)}## SIGNAL DENSITY — ${n} message(s) over 90 days${stated ? `, plus ${i.selfFirst}'s own notes` : ", no personal notes"}.
${n === 0 && !stated ? `⚠️ NO SIGNAL: return empty claim lists. Do NOT invent traits, commitments, or history.` : ""}

## Every claim cites its evidence
Each field is a list of short claims. Every claim lists the ids it rests on, e.g. {"text": "Answers within the hour, in one or two lines.", "evidence": ["H2", "E4", "E9"]}.
- Cite only ids that appear above. A claim with no valid citation is deleted before ${i.selfFirst} sees it.
- **personality**, **reachThem** and **silence** (how they communicate and respond) must cite at least one WRITTEN BY, MEASURED or STATED item. What others say about them is context, not evidence of their style.
- Each message shows where it was said: (1:1), (group) or (meeting). People behave differently in each — when a claim rests on one setting, say so ("In DMs with ${i.selfFirst}…", "In group channels…"); never generalise from one setting to the others.
- "${i.selfFirst} asked … → reply / No reply" items show how they handle ${i.selfFirst}'s asks: use them for **reachThem**, **silence** and **watchOut**.
- Prefer claims that several items support. One item is an anecdote; say so in the claim if that is all there is.
- Fields with too little behind them are replaced with "${NOT_ENOUGH}" by code — do not pad to avoid that.

## The fields, in ${i.selfFirst}'s voice
- **personality** — Observable habits only ("Posts reminders with @here", "Writes in short decisive bursts", "Leads with data, then decides"). Use MEASURED items where they exist.
- **whatMakesThemTick** — What they care about, return to, get excited about. Open with the single most actionable line: it is shown beside their name as "how to land it".
- **watchOut** — Friction points for ${i.selfFirst} to anticipate, and what to do about them.
- **recentActivity** — 2–4 concrete, dated observations, each citing the item it comes from.

How to work with them — practical, for ${i.selfFirst} to act on:
- **howToLandIt** — ONE claim: the single most useful line for getting something agreed with them. Shown beside their name everywhere.
- **reachThem** — Best channel and hours, and how long they really take to reply. Lean on the MEASURED items.
- **decides** — How they make decisions and what changes their mind (data, a peer's view, a deadline, cost…).
- **badNews** — How to deliver bad news or a no to them, from how they have reacted before.
- **silence** — What their silence or a short reply usually means, judged against their own normal.
Leave a field's list empty rather than guess: code shows "${NOT_ENOUGH}" there.
- **changes** — If there was a current profile: one line per field that changed and why, or "No material change." If there was none: "New profile."

## Hard rules
- NEVER assign a personality type or trait label — no DISC, MBTI, Big Five, "introvert", "high conscientiousness" or similar. Describe what they do, not what they are.
- Describe behaviour, not inner states: "replies within the hour and rarely pads", not "anxious to please".
- Terse or direct writing is a style, not a mood. MEASURED items say what is normal for this person; judge against that, not a generic professional norm.
- For a personal contact with only ${i.selfFirst}'s notes, claims READ LIKE a note — "From ${i.selfFirst}'s account, …" — citing the N items.
- Never fabricate quotes, commitments, or positions.

## canonicalFields extraction
Scan ${i.selfFirst}'s notes (the N items) for directly-stated contact details. Extract ONLY what is written explicitly — never infer from email domains or signal. Omit any field not literally present. Return "canonicalFields": {} if nothing is stated.

## Output shape
Return ONLY valid JSON, no markdown fences:
{
  "personality": [{ "text": "...", "evidence": ["E1"] }],
  "whatMakesThemTick": [{ "text": "...", "evidence": ["..."] }],
  "watchOut": [{ "text": "...", "evidence": ["..."] }],
  "recentActivity": [{ "text": "12 Nov — ...", "evidence": ["..."] }],
  "howToLandIt": [{ "text": "...", "evidence": ["..."] }],
  "reachThem": [{ "text": "...", "evidence": ["H1"] }],
  "decides": [{ "text": "...", "evidence": ["..."] }],
  "badNews": [{ "text": "...", "evidence": ["..."] }],
  "silence": [{ "text": "...", "evidence": ["..."] }],
  "changes": "...",
  "summary": "One line on what this profile rests on.",
  "canonicalFields": { "name": "...", "title": "...", "company": "...", "location": "...", "email": "...", "phone": "..." }
}`;
}
