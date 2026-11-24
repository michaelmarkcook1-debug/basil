// Audit 2026-11-24, Part 3 entry 12: a nudge ~20 minutes before external meetings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadTs } from "./_helpers/load-ts.mjs";

const R = loadTs("lib/notify/premeeting-rules.ts");
const now = Date.parse("2026-11-24T13:40:00Z");
const own = new Set(["talentgenius.io"]);
const ev = (over = {}) => ({
  id: "e1", summary: "Acme pricing", start: "2026-11-24T14:00:00Z", end: "2026-11-24T14:30:00Z",
  isAllDay: false, hasVideo: true, attendeeCount: 2, attendees: [], isOrganizer: true, myResponseStatus: "accepted",
  attendeeDetails: [{ name: "Jane Doe", email: "jane@acme.com" }, { name: "Guy", email: "guy@talentgenius.io" }], ...over,
});

test("an external meeting 10–30 minutes away is nudged once, naming the outsiders", () => {
  const due = R.meetingsToNudge([ev()], own, now);
  assert.equal(due.length, 1);
  assert.deepEqual(due[0].external.map((a) => a.email), ["jane@acme.com"]);
  const n = R.nudgeNotification(due[0].event, due[0].external, now);
  assert.equal(n.title, "In 20 min: Acme pricing");
  assert.match(n.body, /^With Jane Doe\./);
  assert.equal(n.url, "/dashboard/meetings/e1");
  assert.equal(R.nudgeKey(ev()), "premeeting:e1:2026-11-24T14:00:00Z");
});

test("internal-only, declined, all-day, free and focus blocks never nudge", () => {
  const internal = ev({ attendeeDetails: [{ name: "Guy", email: "guy@talentgenius.io" }] });
  for (const e of [internal, ev({ myResponseStatus: "declined" }), ev({ isAllDay: true }), ev({ transparent: true }), ev({ eventType: "focusTime" }), ev({ attendeeDetails: [] })]) {
    assert.equal(R.meetingsToNudge([e], own, now).length, 0);
  }
});

test("too soon or too far: outside the 10–30 minute window", () => {
  assert.equal(R.meetingsToNudge([ev({ start: "2026-11-24T13:48:00Z" })], own, now).length, 0);
  assert.equal(R.meetingsToNudge([ev({ start: "2026-11-24T14:15:00Z" })], own, now).length, 0);
  assert.equal(R.meetingsToNudge([ev({ start: "2026-11-24T14:10:00Z" })], own, now).length, 1);
});

test("Outlook ids are encoded in the prep link", () => {
  assert.equal(R.nudgeNotification(ev({ id: "ms:AAk/x=" }), [{ name: "Jane", email: "jane@acme.com" }], now).url, "/dashboard/meetings/ms%3AAAk%2Fx%3D");
});

test("cron: every 10 minutes, reads the calendar only for users who can receive it, never calls AI", () => {
  const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.ok(vercel.crons.some((c) => c.path === "/api/cron/premeeting" && c.schedule === "*/10 * * * *"));
  const src = readFileSync(new URL("../app/api/cron/premeeting/route.ts", import.meta.url), "utf8");
  assert.match(src, /if \(!state\.prefs\.meetings\)/);
  assert.match(src, /state\.devices\.length === 0/);
  assert.match(src, /st === "away" \|\| st === "non-working"/);
  assert.match(src, /onceKeys: \[nudgeKey\(event\)\]/);
  assert.doesNotMatch(src, /generateText|generate\/meeting-prep/);
  assert.match(readFileSync(new URL("../lib/notify/rules.ts", import.meta.url), "utf8"), /meetings: true/);
});
