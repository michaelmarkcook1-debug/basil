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

import type { Baseline, RecentSignals } from "@/lib/contacts/relationship-signals";

export interface PriorProfile {
  personality?: string;
  whatMakesThemTick?: string;
  watchOut?: string;
  generatedAt?: string;
}

export interface ProfileEvidence {
  /** `- [date] From X: "subject" — snippet` lines, newest first. */
  emailLines: string[];
  /** Full bodies of a few direct emails from the person, newest first. */
  emailBodies: Array<{ date: string; subject: string; body: string }>;
  slackLines: string[];
  zoomBlocks: string[];
  whatsappLines: string[];
  teamsLines: string[];
  teamsMeetingBlocks: string[];
}

export interface ProfileInputs {
  name: string;
  email?: string;
  phone?: string;
  directory: "work" | "personal";
  /** The user's first name, for the prompt's voice. */
  selfFirst: string;
  /** What the user typed this time. */
  notes?: string;
  /** What the user has told Basil before (survives regeneration). */
  ownerNotes?: string;
  prior?: PriorProfile;
  baseline?: Baseline;
  recent?: RecentSignals;
  /** Plain-English facts from relationship-signals.describeSignals. */
  facts?: string[];
  evidence: ProfileEvidence;
}

export function signalCount(e: ProfileEvidence): number {
  return e.emailLines.length + e.emailBodies.length + e.slackLines.length + e.zoomBlocks.length
    + e.whatsappLines.length + e.teamsLines.length + e.teamsMeetingBlocks.length;
}

const block = (title: string, body: string | null) => (body ? `## ${title}\n${body}\n` : "");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function habitsBlock(base: Baseline | undefined, facts: string[] | undefined): string | null {
  if (!base || base.n < 5) return null;
  const lines = [
    `- Over the last 90 days: ${base.n} messages from them. Median ${Math.round(base.medianWords)} words a message${base.shortShare >= 0.5 ? " (mostly one-liners)" : ""}.`,
    base.medianReplyHours !== undefined ? `- Usually replies within ${base.medianReplyHours < 1 ? "the hour" : base.medianReplyHours < 48 ? `${Math.round(base.medianReplyHours)} hours` : `${Math.round(base.medianReplyHours / 24)} days`}.` : null,
    base.initiationShare !== undefined ? `- Starts ${Math.round(base.initiationShare * 100)}% of the conversations between you.` : null,
    ...(facts ?? []).map((f) => `- ${f}`),
  ].filter(Boolean);
  return lines.join("\n");
}

/** Exported for tests. */
export function buildProfilePrompt(i: ProfileInputs): string {
  const e = i.evidence;
  const n = signalCount(e);
  const stated = [i.ownerNotes?.trim(), i.notes?.trim()].filter(Boolean);
  const statedBlock = stated.length
    ? `## WHAT ${i.selfFirst.toUpperCase()} HAS TOLD BASIL (stated facts — these outrank anything inferred below)\n${stated.map((s) => `> ${s}`).join("\n\n")}\n`
    : "";
  const priorBlock = i.prior && (i.prior.personality || i.prior.whatMakesThemTick || i.prior.watchOut)
    ? `## THE CURRENT PROFILE (written ${i.prior.generatedAt?.slice(0, 10) ?? "earlier"}) — revise, do not restart
- personality: ${i.prior.personality ?? "(none)"}
- whatMakesThemTick: ${i.prior.whatMakesThemTick ?? "(none)"}
- watchOut: ${i.prior.watchOut ?? "(none)"}
Keep every line that still holds. Change a line only where the evidence below contradicts it, and name what changed in "changes". Never drop a stated fact from ${i.selfFirst} in favour of an inference.\n`
    : "";
  const bodiesBlock = e.emailBodies.length
    ? e.emailBodies.map((b) => `--- [${b.date.slice(0, 10)}] "${b.subject}"\n${clip(b.body, 1800)}`).join("\n\n")
    : null;

  return `Write or update a personality profile for one of ${i.selfFirst}'s contacts. Match the style of hand-written chief-of-staff notes: specific, observational, grounded in evidence. No fluff.

## CONTACT
Name: ${i.name}
${i.email ? `Email: ${i.email}\n` : ""}${i.phone ? `Phone: ${i.phone}\n` : ""}Directory: ${i.directory} ${i.directory === "personal" ? "(friend / family — not a colleague)" : "(colleague, investor, client, or vendor)"}

${statedBlock}${priorBlock}${block("MEASURED HABITS (computed from message history — these are facts, not guesses)", habitsBlock(i.baseline, i.facts))}${block(`EMAILS FROM THEM, IN FULL (${e.emailBodies.length}, newest first)`, bodiesBlock)}${block(`GMAIL SIGNAL (${e.emailLines.length} messages, most recent first)`, e.emailLines.length ? e.emailLines.join("\n") : null)}${block(`SLACK SIGNAL (${e.slackLines.length} messages mentioning or from them)`, e.slackLines.length ? e.slackLines.join("\n") : null)}${block("ZOOM AI COMPANION SUMMARIES mentioning them", e.zoomBlocks.length ? e.zoomBlocks.join("\n\n") : null)}${block(`WHATSAPP SIGNAL (${e.whatsappLines.length} messages)`, e.whatsappLines.length ? e.whatsappLines.join("\n") : null)}${block(`MICROSOFT TEAMS CHAT (${e.teamsLines.length} messages)`, e.teamsLines.length ? e.teamsLines.join("\n") : null)}${block(`MICROSOFT TEAMS MEETINGS (${e.teamsMeetingBlocks.length})`, e.teamsMeetingBlocks.length ? e.teamsMeetingBlocks.join("\n\n") : null)}
## SIGNAL DENSITY — ${n} item(s) of hard signal over 90 days${stated.length ? `, plus ${i.selfFirst}'s own notes` : ", no personal notes"}.
${n === 0 && !stated.length ? `⚠️ NO SIGNAL: say so honestly in the fields. Do NOT invent traits, commitments, or history. Return short placeholder strings that mark the gap.` : ""}

## How Basil writes personality profiles
Each field is one compact paragraph, in ${i.selfFirst}'s voice, grounded in evidence:

- **personality** — How they communicate and operate. Observable habits only ("Posts reminders with @here", "Writes in short decisive bursts", "Leads with data, then decides"). Use the MEASURED HABITS where they exist. No adjective soup.
- **whatMakesThemTick** — What they care about, what energises them. Draw from what they share, return to, get excited about. Open with the single most actionable line: it is shown beside their name as "how to land it".
- **watchOut** — Friction points for ${i.selfFirst} to anticipate. "Her silence usually means X." "He expects Y within hours." Practical — what ${i.selfFirst} can actually DO with it.
- **recentActivity** — 2–4 concrete, dated observations from the evidence. Not generalities.
- **activitySource** — The sources used, comma-separated.
- **changes** — If there was a current profile: one line per field that changed and why, or "No material change." If there was none: "New profile."

## Hard rules
- Every specific claim traces to the evidence above or to ${i.selfFirst}'s stated notes. If the data doesn't support it, don't claim it.
- NEVER assign a personality type or trait label — no DISC, MBTI, Big Five, "introvert", "high conscientiousness" or similar. Describe what they do, not what they are.
- Describe behaviour, not inner states: "replies within the hour and rarely pads", not "anxious to please".
- Terse or direct writing is a style, not a mood. The MEASURED HABITS say what is normal for this person; judge against that, not against a generic professional norm.
- For a personal contact with only ${i.selfFirst}'s notes, the profile should READ LIKE a note — "From ${i.selfFirst}'s account, Sarah is…".
- Never fabricate quotes, commitments, or positions.

## canonicalFields extraction
Scan ${i.selfFirst}'s notes for directly-stated contact details. Extract ONLY what is written explicitly — never infer from email domains or signal. Omit any field not literally present. Return "canonicalFields": {} if nothing is stated.

## Output shape
Return ONLY valid JSON, no markdown fences:
{
  "personality": "...",
  "whatMakesThemTick": "...",
  "watchOut": "...",
  "recentActivity": "...",
  "activitySource": "...",
  "changes": "...",
  "summary": "One line on signal density and what this profile rests on.",
  "canonicalFields": { "name": "...", "title": "...", "company": "...", "location": "...", "email": "...", "phone": "..." }
}`;
}
