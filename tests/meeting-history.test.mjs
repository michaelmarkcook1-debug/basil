/**
 * Permanent, person-tagged meeting history (audit item 3, 2026-11-24).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadTs } from "./_helpers/load-ts.mjs";

const H = loadTs("lib/meetings/history.ts");
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const m = (o) => ({ id: "x", source: "Zoom meeting", title: "t", date: "2026-11-01T10:00:00Z", attendees: [], attendeeEmails: [], summary: "", topics: [], decisions: [], actions: [], openQuestions: [], recordedAt: "", ...o });

test("names match whole or by first + last; a bare first name doesn't claim everyone", () => {
  assert.equal(H.sameName("Jane Doe", "jane doe"), true);
  assert.equal(H.sameName("Jane A. Doe", "Jane Doe"), true);
  assert.equal(H.sameName("Jane", "Jane Doe"), false);
  assert.equal(H.sameName("Jane Smith", "Jane Doe"), false);
});

test("meetings with a person by email or name, newest first", () => {
  const hist = [
    m({ id: "a", date: "2026-10-01T00:00:00Z", attendees: ["Jane Doe"] }),
    m({ id: "b", date: "2026-11-20T00:00:00Z", attendeeEmails: ["jane@acme.com"] }),
    m({ id: "c", attendees: ["Bob Lee"] }),
  ];
  assert.deepEqual([...H.meetingsWith(hist, { names: ["Jane Doe"], emails: ["JANE@acme.com"] }).map((x) => x.id)], ["b", "a"]);
});

test("history block carries what was decided and left to do", () => {
  const b = H.historyBlock([m({ title: "Pricing", attendees: ["Jane Doe"], summary: "Agreed pilot.", decisions: ["Run a 3-month pilot"], actions: [{ text: "Send the contract", owner: "Jane" }], openQuestions: ["Who signs?"] })]);
  assert.match(b, /2026-11-01 · Zoom meeting · "Pricing" · with Jane Doe/);
  assert.match(b, /Decided: Run a 3-month pilot/);
  assert.match(b, /Actions: Jane: Send the contract/);
  assert.match(b, /Open: Who signs\?/);
});

test("their own words come from speaker-labelled transcript lines; one-word replies are skipped", () => {
  const lines = [{ text: "Jane Doe: I need the numbers before Friday's board." }, { text: "Jane Doe: Yes." }, { text: "Bob Lee: Sure, we can do that by then." }];
  assert.deepEqual([...H.spokenBy(lines, "Jane Doe")], ["I need the numbers before Friday's board."]);
});

test("wiring: every meeting path records it; prep, profiles and chat read it", () => {
  assert.match(src("lib/email/process-gmail-message.ts"), /await recordMeeting\(username, \{/);
  assert.match(src("lib/zoom/process-meeting.ts"), /await recordMeeting\(username, \{/);
  assert.match(src("app/api/generate/meeting-prep/route.ts"), /## EARLIER MEETINGS WITH THESE ATTENDEES/);
  assert.match(src("lib/contacts/generate-profile.ts"), /by: "them", setting: "meeting"/);
  assert.match(src("lib/ai/tools.ts"), /meetingHistory: tool\(/);
  assert.match(src("lib/meetings/history-store.ts"), /seedFromUploads/, "starts populated from meetings already processed");
});
