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
  assert.match(d, /recentInbox\(username, 50, 7\)/);
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

// Part 3 entry 8: Microsoft parity.
test("briefing, meeting prep and digest read every connected calendar and mailbox", () => {
  const b = read("app/api/generate/briefing/route.ts");
  assert.match(b, /readCalendar\(username, \{ days: 1 \}, tz\)/);
  assert.match(b, /recentInbox\(username/);
  assert.match(b, /recentSent\(username/);
  assert.doesNotMatch(b, /getTodayEvents\(|getRecentEmails\(|getSentEmails\(/);
  const m = read("app/api/generate/meeting-prep/route.ts");
  assert.match(m, /recentInbox\(username, 50, MEETING_PREP_EMAIL_DAYS\)/);
  assert.match(m, /recentSent\(username, 30, MEETING_PREP_EMAIL_DAYS\)/);
  assert.match(m, /readCalendar\(username, \{ days: 1 \}\)/);
  assert.match(m, /YOU SENT to/);
  const d = read("app/api/generate/digest/route.ts");
  assert.match(d, /readCalendar\(username, \{ from: day\(sevenDaysAgo\), to: day\(sevenDaysAhead\) \}, tz\)/);
  assert.doesNotMatch(d, /getEventsForMonth|getRecentEmails\(|getSentEmails\(/);
  const u = read("lib/mail/unified.ts");
  assert.match(u, /folder: "inbox" \| "sent"/);
  assert.match(u, /id: `outlook:\$\{m\.id\}`/);
  assert.match(u, /No mailbox could be read/);
  assert.match(read("lib/microsoft/outlook-mail.ts"), /\/me\/mailFolders\/sentitems\/messages/);
});

// Part 3 entry 9: chat remembers who the conversation is about.
import { loadTs } from "./_helpers/load-ts.mjs";
const C = loadTs("lib/people/carry-over.ts");
const person = (name, names = [name]) => ({ id: `name:${name.toLowerCase()}`, name, names, emails: [], phones: [], slackIds: [], pipedrivePersonIds: [], sources: [] });
const people = [person("Jane Doe", ["Jane Doe", "Jane"]), person("Tom Smith"), person("Olivia Price")];

test("carry-over: a follow-up that names nobody inherits the people from earlier turns", () => {
  assert.deepEqual([...C.carryOverPeople("what does she want?", ["Jane Doe wants the pricing by Friday", "what's going on with Jane Doe?"], people)], ["Jane Doe"]);
});

test("carry-over: a message that names someone new does not inherit", () => {
  assert.deepEqual([...C.carryOverPeople("what about Tom Smith?", ["Jane Doe wants pricing"], people)], []);
});

test("carry-over: first names and words inside other words never match", () => {
  assert.deepEqual([...C.fullNamesIn("Jane said yes", people)], []);
  assert.deepEqual([...C.fullNamesIn("tomsmith@x.com", people)], []);
  assert.deepEqual([...C.fullNamesIn("Olivia Price and Tom Smith", people)], ["Tom Smith", "Olivia Price"]);
});

test("carry-over: newest turn first, at most three people", () => {
  const many = [...people, person("Ann Lee"), person("Raj Patel")];
  assert.deepEqual([...C.carryOverPeople("and her?", ["Ann Lee and Raj Patel", "Jane Doe, Tom Smith"], many)], ["Raj Patel", "Ann Lee", "Tom Smith"]);
});

test("chat passes carried people as memory focus entities", () => {
  const r = read("app/api/chat/route.ts");
  assert.match(r, /carryOverPeople\(focusText, earlier, ix\.people\)/);
  assert.match(r, /entities: carried/);
});
