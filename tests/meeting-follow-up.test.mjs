// Audit 2026-11-24, Part 3 entry 13: a follow-up email drafted after each
// external recorded meeting, queued for approval — never sent on its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadTs } from "./_helpers/load-ts.mjs";

const F = loadTs("lib/meetings/follow-up-shape.ts");
const now = Date.parse("2026-11-24T16:00:00Z");
const own = new Set(["talentgenius.io"]);
const rec = (over = {}) => ({
  id: "zoom-api:1", source: "Zoom meeting", title: "Acme pricing", date: "2026-11-24T14:00:00Z",
  attendees: ["Jane Doe", "Guy"], attendeeEmails: ["jane@acme.com", "guy@talentgenius.io", "no-reply@zoom.us"],
  summary: "Agreed the pilot scope.", topics: [], decisions: ["Pilot starts 1 Dec"], actions: [{ text: "Send the order form", owner: "Michael" }],
  openQuestions: [], recordedAt: "2026-11-24T15:00:00Z", ...over,
});

test("only the outside attendees receive it; bots and own domain are left out", () => {
  assert.deepEqual([...F.followUpRecipients(rec(), own)], ["jane@acme.com"]);
});

test("drafted for a fresh external meeting with something to recap", () => {
  assert.equal(F.wantsFollowUp(rec(), own, now), true);
  assert.equal(F.wantsFollowUp(rec({ attendeeEmails: ["guy@talentgenius.io"] }), own, now), false, "internal meetings: no follow-up");
  assert.equal(F.wantsFollowUp(rec({ date: "2026-11-22T10:00:00Z" }), own, now), false, "older than 36h: never from a reprocess");
  assert.equal(F.wantsFollowUp(rec({ decisions: [], actions: [], summary: "short" }), own, now), false, "nothing to recap");
});

test("the prompt forbids inventing owners or dates and leaking internal matters", () => {
  const p = F.followUpPrompt(rec(), "Michael", ["jane@acme.com"], "## How Michael actually writes\n- Signs off: \"Best, Michael\".");
  assert.match(p, /never invent a date or an owner/);
  assert.match(p, /Nothing internal or sensitive/);
  assert.match(p, /Send the order form — Michael/);
  assert.match(p, /How Michael actually writes/);
});

test("queued as a pending send_email draft, deduped per meeting, pushed once; wired after both history writes", () => {
  const src = readFileSync(new URL("../lib/meetings/follow-up.ts", import.meta.url), "utf8");
  assert.match(src, /status: "pending"/);
  assert.match(src, /actionType: "send_email"/);
  assert.match(src, /sourceRef: `followup:\$\{rec\.id\}`/);
  assert.match(src, /createEventIfNew\(/);
  assert.doesNotMatch(src, /sendEmail\(/, "it must never send by itself");
  for (const f of ["lib/email/process-gmail-message.ts", "lib/zoom/process-meeting.ts"]) {
    assert.match(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"), /await recordMeeting\(username, meetingRec\)[^\n]*\n[^\n]*\n\s+await draftMeetingFollowUp\(username, meetingRec\);/, f);
  }
});
