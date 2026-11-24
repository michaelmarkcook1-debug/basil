// Audit 2026-11-24, item 6 (Part 3 entries 2, 3, 7): briefing and digest labels
// match the windows they read; the briefing's memories are ranked like chat's
// (expired ones dropped); chat and profile Gmail searches reach back a year.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("briefing headers name the window each source really reads", () => {
  const b = read("app/api/generate/briefing/route.ts");
  assert.doesNotMatch(b, /### [A-Z ]+ — last 48h/, "no fixed 48h header while reads reach back up to 21 days");
  assert.match(b, /### EMAILS — \$\{lastDays\(gapDays\)\}/);
  assert.match(b, /### SLACK — \$\{lastDays\(wideDays\)\}/);
  assert.match(b, /ZOOM MEETING SUMMARIES — \$\{lastDays\(wideDays\)\}/);
  assert.match(b, /READ\.AI MEETING SUMMARIES — \$\{lastDays\(wideDays\)\}/);
  assert.match(b, /DECISION LOG — active decisions from \$\{lastDays\(decisionWindowDays\)\}/);
  assert.match(b, /const wideDays = Math\.max\(7, gapDays\)/);
});

test("digest reads the 7 days of email its prompt says it covers", () => {
  const d = read("app/api/generate/digest/route.ts");
  assert.match(d, /getRecentEmails\(username, 50, 7\)/);
  assert.doesNotMatch(d, /getRecentEmails\(username, 30\)\s*;/);
  assert.match(d, /RECENT EMAILS \(last 7 days\)/);
});

test("briefing memories: ranked with rankForPrompt (expired dropped), not the newest 15", () => {
  const b = read("app/api/generate/briefing/route.ts");
  assert.match(b, /rankForPrompt\(memoriesResult as Memory\[\]/);
  assert.doesNotMatch(b, /thirtyDaysAgo/);
});

test("Gmail: chat and profile searches reach back a year; own date operators are kept", () => {
  const g = read("lib/google/gmail.ts");
  assert.match(g, /\(after\|before\|newer_than\|older_than\):/);
  const t = read("lib/ai/tools.ts");
  assert.match(t, /searchEmails\(username, query, max, Math\.min\(3650, Math\.max\(1, days \?\? 365\)\)\)/);
  assert.match(read("lib/contacts/generate-profile.ts"), /: name, 15, 365\)/);
});

test("whoIs returns the saved contact profile when the person is on the Contacts page", () => {
  const t = read("lib/ai/tools.ts");
  assert.match(t, /getOverrideFromStore\(username, hit\.contactId!\)/);
  assert.match(t, /return \{ person: hit, \.\.\.\(savedProfile \? \{ savedProfile \} : \{\}\) \}/);
});
