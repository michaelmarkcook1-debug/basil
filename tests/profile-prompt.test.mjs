// What a personality profile is built from (docs/personality-profiles-review-2026-10-21.md §4).
// The user's stated notes outrank inference and survive regeneration; the
// previous profile is revised, not restarted; habits are measured, not guessed;
// and nobody is ever typed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadTs } from "./_helpers/load-ts.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const P = loadTs("lib/contacts/profile-prompt.ts");

const empty = { emailLines: [], emailBodies: [], slackLines: [], zoomBlocks: [], whatsappLines: [], teamsLines: [], teamsMeetingBlocks: [] };
const base = { name: "Priya Shah", directory: "work", selfFirst: "Michael", evidence: empty };

test("the user's notes are stated facts that outrank inference, and earlier notes come along", () => {
  const p = P.buildProfilePrompt({ ...base, ownerNotes: "Priya prefers numbers before narrative.", notes: "She just moved to CFO." });
  assert.match(p, /WHAT MICHAEL HAS TOLD BASIL \(stated facts — these outrank anything inferred below\)/);
  assert.match(p, /> Priya prefers numbers before narrative\./);
  assert.match(p, /> She just moved to CFO\./);
  assert.match(p, /plus Michael's own notes/);
});

test("regeneration is additive: the current profile goes in and the model must say what changed", () => {
  const p = P.buildProfilePrompt({ ...base, prior: { personality: "Short decisive bursts.", whatMakesThemTick: "Numbers first.", watchOut: "Silence means no.", generatedAt: "2026-06-03T10:00:00Z" } });
  assert.match(p, /THE CURRENT PROFILE \(written 2026-06-03\) — revise, do not restart/);
  assert.match(p, /- personality: Short decisive bursts\./);
  assert.match(p, /Keep every line that still holds/);
  assert.match(p, /name what changed in "changes"/);
  assert.match(p, /"changes": "\.\.\."/, "the output shape asks for it");
  // First time: no prior block at all.
  assert.doesNotMatch(P.buildProfilePrompt(base), /THE CURRENT PROFILE/);
});

test("measured habits go in as facts, and email bodies in full", () => {
  const p = P.buildProfilePrompt({
    ...base,
    baseline: { n: 24, medianWords: 3, shortShare: 0.9, medianReplyHours: 0.5, initiationShare: 0.6 },
    facts: ["Replies in about 30m, as usual."],
    evidence: { ...empty, emailBodies: [{ date: "2026-10-01T09:00:00Z", subject: "Board model", body: "Michael — numbers first please. Scenario B only.\n\nP" }] },
  });
  assert.match(p, /MEASURED HABITS \(computed from message history — these are facts, not guesses\)/);
  assert.match(p, /24 messages from them\. Median 3 words a message \(mostly one-liners\)/);
  assert.match(p, /Usually replies within the hour/);
  assert.match(p, /Starts 60% of the conversations/);
  assert.match(p, /EMAILS FROM THEM, IN FULL \(1, newest first\)/);
  assert.match(p, /Scenario B only\./);
  // Under 5 messages there is no baseline block: nothing to compare against.
  assert.doesNotMatch(P.buildProfilePrompt({ ...base, baseline: { n: 3, medianWords: 3, shortShare: 1 } }), /## MEASURED HABITS/);
});

test("the hard rules: no trait types, behaviour not inner states, terse is a style", () => {
  const p = P.buildProfilePrompt(base);
  assert.match(p, /NEVER assign a personality type or trait label — no DISC, MBTI, Big Five/);
  assert.match(p, /Describe behaviour, not inner states/);
  assert.match(p, /Terse or direct writing is a style, not a mood/);
  assert.match(p, /Open with the single most actionable line: it is shown beside their name/);
});

test("no signal and no notes: the prompt says so and forbids invention", () => {
  const p = P.buildProfilePrompt(base);
  assert.match(p, /0 item\(s\) of hard signal over 90 days, no personal notes/);
  assert.match(p, /NO SIGNAL: say so honestly/);
  assert.equal(P.signalCount(empty), 0);
});

test("the route reads 90 days, fetches bodies, brings the prior profile and notes, and honours the switch", () => {
  const r = src("app/api/contacts/generate-profile/route.ts");
  assert.match(r, /const WINDOW_DAYS = 90/);
  assert.match(r, /getRecentEmails\(username, 400, WINDOW_DAYS\)/, "not the 2-day default any more");
  assert.match(r, /getRecentSlackMessages\(username, 2500, WINDOW_DAYS\)/, "same call as the tone read → served from its cache");
  assert.match(r, /getEmailBody\(username, e\.id\)/);
  assert.match(r, /ownerNotes = override\?\.ownerNotes/);
  assert.match(r, /prior, baseline, recent, facts, evidence/);
  assert.match(r, /settings\.toneSentiment !== false/, "tone & sentiment off → no message data is read");
  assert.match(src("lib/ai/schemas.ts"), /changes:\s+z\.string\(\)\.optional\(\)/);
  assert.match(src("app/api/contacts/overrides/[id]/route.ts"), /ownerNotes: z\.string\(\)\.max\(4000\)\.optional\(\)/);
});
