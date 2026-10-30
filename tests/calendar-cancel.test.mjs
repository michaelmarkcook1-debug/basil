// Cancelling from the Calendar page (lib/google/calendar.ts cancelEvent,
// app/api/calendar/[eventId] DELETE, components/calendar/cancel-meeting.tsx),
// and drawing meetings that are not yet accepted (lib/calendar/meeting-state.ts).
//
// Before 2026-10-30 the DELETE removed the event with Google's default of no
// notifications: guests of a cancelled meeting were never told, and leaving
// someone else's meeting never told the organiser.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadTs } from "./_helpers/load-ts.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const j = (x) => JSON.stringify(x);

/** A fake Google Calendar holding one event; records every call. */
function fakeGoogle(event) {
  const calls = [];
  const events = {
    get: async (a) => { calls.push(["get", a]); return { data: structuredClone(event) }; },
    delete: async (a) => { calls.push(["delete", a]); return {}; },
    patch: async (a) => { calls.push(["patch", a]); return {}; },
  };
  return { calls, google: { calendar: () => ({ events }) } };
}

function loadCalendar(event, { emailFails = false } = {}) {
  const g = fakeGoogle(event);
  const sent = [];
  const C = loadTs("lib/google/calendar.ts", {
    googleapis: { google: g.google },
    "./auth": { getAuthedClient: async () => ({}) },
    "@/lib/self-identity": { getSelfIdentity: async () => ({ emails: [], names: [] }), stripSelf: (x) => x },
    "./gmail": { sendEmail: async (...a) => { if (emailFails) throw new Error("gmail down"); sent.push(a); return { id: "m1" }; } },
  });
  return { C, calls: g.calls, sent };
}

const MINE = {
  summary: "Pricing review",
  start: { dateTime: "2026-11-02T15:00:00Z", timeZone: "Europe/London" },
  end: { dateTime: "2026-11-02T15:30:00Z", timeZone: "Europe/London" },
  organizer: { self: true, email: "michael@talentgenius.io" },
  attendees: [
    { self: true, email: "michael@talentgenius.io", responseStatus: "accepted" },
    { email: "Ed.Baum@x.io", responseStatus: "needsAction" },
    { email: "malcolm@talentgenius.io", responseStatus: "accepted" },
    { email: "gone@x.io", responseStatus: "declined" },
    { email: "room-1@resource.calendar.google.com", resource: true, responseStatus: "accepted" },
  ],
};
const THEIRS = {
  summary: "Ascendion demo",
  start: { dateTime: "2026-11-03T10:00:00Z" }, end: { dateTime: "2026-11-03T10:30:00Z" },
  organizer: { email: "Malcolm@talentgenius.io", displayName: "Malcolm Frank" },
  attendees: [{ self: true, email: "michael@talentgenius.io", responseStatus: "needsAction" }, { email: "malcolm@talentgenius.io", responseStatus: "accepted" }],
};

test("who cancelling tells: guests who haven't declined (no rooms, not you); the organiser of someone else's meeting", () => {
  const { C } = loadCalendar(MINE);
  assert.equal(j(C.cancelPlan(MINE)), j({ role: "organiser", guests: ["ed.baum@x.io", "malcolm@talentgenius.io"] }));
  assert.equal(C.cancelPlan(THEIRS).role, "guest");
  assert.equal(C.cancelPlan(THEIRS).organizerEmail, "malcolm@talentgenius.io");
  assert.equal(C.cancelPlan({ organizer: { email: "x@y.io" }, attendees: [{ email: "team@y.io" }] }).role, "bystander", "invited through a group");
  assert.equal(C.cancelPlan({}).role, "organiser", "no organiser field = you made it");
});

test("organiser cancels: Google sends the cancellation to everyone, the note follows by email", async () => {
  const { C, calls, sent } = loadCalendar(MINE);
  const r = await C.cancelEvent("michael", "ev1", { notify: true, note: "Moving this to next week." });
  const del = calls.find(([k]) => k === "delete")[1];
  assert.equal(del.sendUpdates, "all");
  assert.equal(r.role, "organiser");
  assert.equal(j(r.told), j(["ed.baum@x.io", "malcolm@talentgenius.io"]));
  assert.equal(r.noteSent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1], "ed.baum@x.io, malcolm@talentgenius.io");
  assert.match(sent[0][2], /^Cancelled: Pricing review \(Mon 2 Nov, 15:00–15:30/);
  assert.equal(sent[0][3], "Moving this to next week.");
});

test("organiser cancels quietly: no notice, no email", async () => {
  const { C, calls, sent } = loadCalendar(MINE);
  const r = await C.cancelEvent("michael", "ev1", { notify: false, note: "ignored" });
  assert.equal(calls.find(([k]) => k === "delete")[1].sendUpdates, "none");
  assert.equal(r.told.length, 0);
  assert.equal(sent.length, 0);
});

test("a failed note email does not undo the cancellation; it is reported", async () => {
  const { C, calls } = loadCalendar(MINE, { emailFails: true });
  const r = await C.cancelEvent("michael", "ev1", { notify: true, note: "Sorry all" });
  assert.ok(calls.some(([k]) => k === "delete"));
  assert.equal(r.noteSent, false);
  assert.equal(r.told.length, 2);
});

test("guest leaves: declines with the note (organiser told), then it leaves your calendar", async () => {
  const { C, calls, sent } = loadCalendar(THEIRS);
  const r = await C.cancelEvent("michael", "ev2", { notify: true, note: "Clash, sorry" });
  const patch = calls.find(([k]) => k === "patch")[1];
  assert.equal(patch.sendUpdates, "all");
  const me = patch.requestBody.attendees.find((a) => a.self);
  assert.equal(me.responseStatus, "declined");
  assert.equal(me.comment, "Clash, sorry");
  assert.equal(calls.find(([k]) => k === "delete")[1].sendUpdates, "none", "removing your copy sends nothing more");
  assert.equal(j(r.told), j(["malcolm@talentgenius.io"]));
  assert.equal(sent.length, 0, "no email — the note rides on the decline");
});

test("guest leaves quietly: the decline is not announced", async () => {
  const { C, calls } = loadCalendar(THEIRS);
  const r = await C.cancelEvent("michael", "ev2", { notify: false });
  assert.equal(calls.find(([k]) => k === "patch")[1].sendUpdates, "none");
  assert.equal(r.told.length, 0);
});

test("the route tells people by default, and the old silent delete is gone", () => {
  const r = src("app/api/calendar/[eventId]/route.ts");
  assert.match(r, /const notify = body\?\.notify !== false;/);
  assert.match(r, /await cancelEvent\(username, eventId, \{ notify, note \}\)/);
  assert.doesNotMatch(src("lib/google/calendar.ts"), /deleteCalendarEvent/);
});

test("guest answers are counted (you and rooms excluded) and carried on every event", () => {
  const { C } = loadCalendar(MINE);
  assert.equal(j(C.guestTally(MINE.attendees)), j({ total: 3, accepted: 1, tentative: 0, declined: 1, waiting: 1 }));
  assert.match(src("lib/google/calendar.ts"), /guests: guestTally\(e\.attendees\),\s+recurring: Boolean\(e\.recurringEventId\),/);
});

test("not-yet-accepted meetings: unanswered, maybe, and your own meeting nobody has said yes to", () => {
  const S = loadTs("lib/calendar/meeting-state.ts");
  const g = (o) => ({ total: 0, accepted: 0, tentative: 0, declined: 0, waiting: 0, ...o });
  assert.equal(S.meetingState({ myResponseStatus: "needsAction" }), "invite");
  assert.equal(S.meetingState({ myResponseStatus: "tentative" }), "tentative");
  assert.equal(S.meetingState({ myResponseStatus: "declined" }), "declined");
  assert.equal(S.meetingState({ myResponseStatus: "accepted" }), "meeting");
  assert.equal(S.meetingState({ isOrganizer: true, myResponseStatus: "accepted", guests: g({ total: 2, waiting: 2 }) }), "awaiting");
  assert.equal(S.meetingState({ isOrganizer: true, myResponseStatus: "accepted", guests: g({ total: 2, waiting: 1, accepted: 1 }) }), "meeting", "one yes is enough to be on");
  assert.equal(S.meetingState({ isOrganizer: true, myResponseStatus: "accepted", guests: g() }), "meeting", "a solo block is not waiting on anyone");
  assert.equal(S.statePill({ isOrganizer: true, guests: g({ total: 6, waiting: 2, accepted: 4 }) }).text, "2 of 6 haven't replied");
  assert.equal(S.statePill({ isOrganizer: true, guests: g({ total: 1, waiting: 1 }) }).text, "Guest hasn't accepted");
  assert.equal(S.statePill({ myResponseStatus: "needsAction" }).text, "Not answered");
  assert.equal(S.statePill({ myResponseStatus: "accepted" }), null);
});

test("the dialog names who will hear before you confirm", () => {
  const D = loadTs("lib/calendar/cancel-copy.ts");
  const org = D.cancelCopy({ id: "1", summary: "x", start: "", end: "", isOrganizer: true, attendees: ["Ed", "Malcolm", "Andrew", "Guy", "Sam"] });
  assert.equal(org.action, "Cancel meeting");
  assert.equal(org.tell, "Send all 5 guests a cancellation (Ed, Malcolm, Andrew and 2 more)");
  assert.equal(D.cancelCopy({ id: "1", summary: "x", start: "", end: "", isOrganizer: true, attendees: [] }).tell, null, "solo: nobody to tell");
  const guest = D.cancelCopy({ id: "1", summary: "x", start: "", end: "", isOrganizer: false, organizerName: "Malcolm Frank" });
  assert.equal(guest.action, "Decline and remove");
  assert.equal(guest.tell, "Tell Malcolm Frank you're not coming");
});

test("the page is called Calendar everywhere it is linked", () => {
  assert.match(src("components/app-sidebar.tsx"), /\{ href: "\/dashboard\/meetings",\s+label: "Calendar",/);
  assert.match(src("components/mobile-bottom-nav.tsx"), /\{ href: "\/dashboard\/meetings",\s+label: "Calendar",/);
  assert.match(src("components/command-palette.tsx"), /\{ label: "Calendar",\s+href: "\/dashboard\/meetings",/);
  const p = src("app/dashboard/meetings/page.tsx");
  assert.match(p, /title="Calendar"/);
  assert.match(p, /<CancelMeetingDialog/);
  assert.match(p, /onChanged=\{\(st\) => onAnswered\(event\.id, st\)\}/, "answering redraws the graphic");
});
