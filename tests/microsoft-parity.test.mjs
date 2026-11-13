// Microsoft 365 on a par with Google ("Phase 3: both gardens").
//
// Done when a Teams/Outlook invite from a client and a Google invite from the
// team clash, and Basil catches it. Runs the real modules with their network
// boundaries mocked (tests/_helpers/load-ts.mjs):
//   lib/microsoft/outlook-calendar.ts   Outlook → CalendarEvent, Graph reads and writes
//   lib/calendar/unified.ts             merge, de-dupe, clashes, degraded providers
//   lib/calendar/writes.ts              writes routed to the event's own provider
//   lib/microsoft/mail-provider.ts + lib/ai/tools.ts   email through Outlook when it should
//   B10 lib/microsoft/auth.ts, B7 the Outlook calendar webhook, B5 availability,
//   B11 all-day edits, tzDayBounds on clock-change days and paging.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { loadTs, nextServer } from "./_helpers/load-ts.mjs";

const require = createRequire(import.meta.url);
const ai = require("ai");
const j = (x) => JSON.parse(JSON.stringify(x));
const away = loadTs("lib/away/calendar.ts");
const json = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-11-10T09:00:00Z");

/** A client's Teams meeting as Graph returns it (UTC, because we ask for UTC). */
const CLIENT_TEAMS = {
  id: "AAMkClientQbr=",
  iCalUId: "040000008200E00074C5B7101A82E008-CLIENT-QBR",
  subject: "Client QBR",
  bodyPreview: "Quarterly review with the client team.",
  start: { dateTime: "2026-11-12T15:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-11-12T16:00:00.0000000", timeZone: "UTC" },
  isAllDay: false,
  isOrganizer: false,
  showAs: "busy",
  type: "occurrence",
  seriesMasterId: "AAMkSeries",
  isOnlineMeeting: true,
  onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc" },
  location: { displayName: "Microsoft Teams Meeting" },
  attendees: [
    { emailAddress: { address: "me@ms.invalid", name: "Me" }, type: "required", status: { response: "none" } },
    { emailAddress: { address: "Ann@Client.invalid", name: "Ann Lee" }, type: "required", status: { response: "accepted" } },
    { emailAddress: { address: "bob@client.invalid", name: "Bob" }, type: "optional", status: { response: "declined" } },
    { emailAddress: { address: "room-1@client.invalid", name: "Room 1" }, type: "resource", status: { response: "accepted" } },
  ],
  organizer: { emailAddress: { address: "Ann@Client.invalid", name: "Ann Lee" } },
  responseStatus: { response: "tentativelyAccepted" },
};

const map = (e, o = {}) => O().mapOutlookEvent(e, { timezone: "Europe/London", self: { emails: ["me@ms.invalid"] }, now: NOW, ...o });

function O(graphFetch = async () => { throw new Error("no Graph in this test"); }) {
  return loadTs("lib/microsoft/outlook-calendar.ts", { "./auth": { graphFetch }, "@/lib/away/calendar": away });
}

/** CalendarEvents as the two providers hand them to the unified calendar. */
const gEv = (o = {}) => ({
  id: "g1", summary: "Team sync", start: "2026-11-12T15:00:00Z", end: "2026-11-12T15:30:00Z", isAllDay: false, hasVideo: true,
  attendeeCount: 2, attendees: ["Guy", "Omar"], isOrganizer: false, myResponseStatus: "accepted",
  organizerEmail: "guy@team.invalid", provider: "google", ...o,
});
const mEv = (o = {}) => ({
  id: "ms:AAMkClientQbr=", summary: "Client QBR", start: "2026-11-12T15:00:00Z", end: "2026-11-12T16:00:00Z", isAllDay: false, hasVideo: true,
  attendeeCount: 1, attendees: ["Ann Lee"], isOrganizer: false, myResponseStatus: "accepted",
  organizerEmail: "ann@client.invalid", videoLink: "https://teams.microsoft.com/l/meetup-join/abc", provider: "microsoft", ...o,
});

function unifiedWith({ google = true, microsoft = true, googleEvents = [gEv()], outlookEvents = [mEv()], googleFails = false, outlookFails = false, freeBusy } = {}) {
  const calls = [];
  const g = (name) => async (...a) => {
    calls.push([name, ...a]);
    if (googleFails) throw new Error("Google Calendar HTTP 500");
    return structuredClone(googleEvents);
  };
  const U = loadTs("lib/calendar/unified.ts", {
    "@/lib/google/calendar": {
      getEventsForDays: g("google.days"), getEventsForDate: g("google.date"),
      getEventsForDateRange: g("google.range"), getEventsForMonth: g("google.month"),
      checkFreeBusy: async (_u, emails) => freeBusy ?? emails.map((email) => ({ email, busy: [] })),
    },
    "@/lib/google/auth": { isGoogleConnected: async () => google },
    "@/lib/microsoft/auth": { isMicrosoftConnected: async () => microsoft },
    "@/lib/microsoft/outlook-calendar": {
      getOutlookEventsBetween: async (...a) => {
        calls.push(["ms.between", ...a]);
        if (outlookFails) throw new Error("Graph GET /me/calendarView → HTTP 503");
        return outlookEvents === null ? null : structuredClone(outlookEvents);
      },
      checkOutlookFreeBusy: async (_u, emails) => emails.map((email) => ({ email, busy: [] })),
    },
    "@/lib/self-identity": { getSelfIdentity: async () => ({ emails: ["me@team.invalid"], names: [] }) },
    "@/lib/away/calendar": away,
  });
  return { U, calls };
}

// ═════════════════════════════════════════════════════════════════════════════
// Outlook → CalendarEvent
// ═════════════════════════════════════════════════════════════════════════════

test("Outlook mapping: a client's Teams meeting has the same shape as a Google event", () => {
  const ev = map(CLIENT_TEAMS);
  assert.equal(ev.id, "ms:AAMkClientQbr=", "Outlook ids carry the ms: prefix");
  assert.equal(ev.provider, "microsoft");
  assert.equal(ev.start, "2026-11-12T15:00:00Z", "UTC from Graph, written in the user's offset (London is on GMT in November)");
  assert.equal(ev.end, "2026-11-12T16:00:00Z");
  assert.equal(ev.isAllDay, false);
  assert.equal(ev.videoLink, "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc", "join link from onlineMeeting.joinUrl");
  assert.equal(ev.hasVideo, true);
  assert.equal(ev.recurring, true, "an occurrence of a series");
  assert.equal(ev.myResponseStatus, "tentative", "tentativelyAccepted → tentative");
  assert.equal(ev.isOrganizer, false);
  assert.equal(ev.eventType, "default");
  assert.equal(ev.transparent, undefined);
  assert.equal(ev.iCalUID, "040000008200E00074C5B7101A82E008-CLIENT-QBR");
  assert.equal(ev.organizerEmail, "ann@client.invalid");
  assert.equal(ev.organizerName, "Ann Lee");
  assert.deepEqual(j(ev.attendees), ["Ann Lee", "Bob"], "you and the room are not guests");
  assert.equal(ev.attendeeCount, 2);
  assert.deepEqual(j(ev.attendeeDetails), [{ name: "Ann Lee", email: "ann@client.invalid" }], "decliners and rooms left out, addresses lower-cased");
  assert.deepEqual(j(ev.guests), { total: 2, accepted: 1, tentative: 0, declined: 1, waiting: 0 });
  assert.equal(ev.location, "Microsoft Teams Meeting");
  assert.equal(ev.dateLabel, new Date("2026-11-12T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }));
  assert.equal(map({ ...CLIENT_TEAMS, start: { dateTime: "2026-11-11T10:00:00.0000000", timeZone: "UTC" } }).dateLabel, "Tomorrow");
});

test("Outlook mapping: times are written in the user's own offset, so pages put them on the right day", () => {
  const summer = { ...CLIENT_TEAMS, start: { dateTime: "2026-07-01T14:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-07-01T15:00:00.0000000", timeZone: "UTC" } };
  assert.equal(map(summer).start, "2026-07-01T15:00:00+01:00");
  assert.equal(map(summer, { timezone: "America/New_York" }).start, "2026-07-01T10:00:00-04:00");
  const lateNy = { ...CLIENT_TEAMS, start: { dateTime: "2026-11-13T02:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-11-13T03:00:00.0000000", timeZone: "UTC" } };
  assert.equal(map(lateNy, { timezone: "America/New_York" }).start.slice(0, 10), "2026-11-12", "21:00 in New York is still the 12th");
  // A zone Graph names in IANA form is converted, not read as UTC.
  assert.equal(O().graphDateToMs({ dateTime: "2026-07-01T15:00:00.0000000", timeZone: "Europe/London" }), Date.parse("2026-07-01T14:00:00Z"));
});

test("Outlook mapping: all-day out-of-office, a free block, your own meeting, a Zoom link in the body", () => {
  const leave = map({
    id: "AAMkLeave", subject: "Annual leave", isAllDay: true, showAs: "oof", isOrganizer: true,
    start: { dateTime: "2026-11-13T00:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-11-14T00:00:00.0000000", timeZone: "UTC" },
    responseStatus: { response: "organizer" }, attendees: [],
  });
  assert.equal(leave.isAllDay, true);
  assert.equal(leave.start, "2026-11-13", "all-day dates like Google's start.date");
  assert.equal(leave.end, "2026-11-14", "exclusive end, like Google");
  assert.equal(leave.eventType, "outOfOffice", "showAs oof → outOfOffice");
  assert.equal(leave.isOrganizer, true);
  assert.equal(leave.myResponseStatus, "accepted");
  assert.equal(leave.recurring, false);
  // An all-day boundary Graph shifted into another zone is rounded back to its midnight.
  assert.equal(map({ id: "x", isAllDay: true, start: { dateTime: "2026-07-12T23:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-07-13T23:00:00.0000000", timeZone: "UTC" } }).start, "2026-07-13");

  const hold = map({ ...CLIENT_TEAMS, showAs: "free", isOrganizer: true, responseStatus: { response: "organizer" } });
  assert.equal(hold.transparent, true, "Free does not block time");
  assert.equal(hold.myResponseStatus, "accepted");

  const zoom = map({ ...CLIENT_TEAMS, isOnlineMeeting: false, onlineMeeting: null, bodyPreview: "Join https://us02web.zoom.us/j/123?pwd=abc please", seriesMasterId: null, type: "singleInstance" });
  assert.equal(zoom.videoLink, "https://us02web.zoom.us/j/123?pwd=abc");
  assert.equal(zoom.recurring, false);
  assert.equal(map({ ...CLIENT_TEAMS, responseStatus: { response: "notResponded" } }).myResponseStatus, "needsAction");
  assert.equal(map({ ...CLIENT_TEAMS, responseStatus: { response: "declined" } }).myResponseStatus, "declined");
});

test("Outlook read: every page, cancelled meetings dropped, you removed from the guests; a failure throws, not connected is null", async () => {
  const seen = [];
  const page2 = { ...CLIENT_TEAMS, id: "AAMkEarly", subject: "Early call", start: { dateTime: "2026-11-12T08:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-11-12T08:30:00.0000000", timeZone: "UTC" } };
  const graphFetch = async (_u, path, init = {}) => {
    seen.push({ path, prefer: init.headers?.Prefer });
    if (path.startsWith("/me?")) return json({ mail: "me@ms.invalid", displayName: "Me" });
    if (path.includes("skiptoken")) return json({ value: [page2, { ...CLIENT_TEAMS, id: "AAMkGone", isCancelled: true }] });
    return json({ value: [CLIENT_TEAMS], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=2" });
  };
  const events = await O(graphFetch).getOutlookEventsBetween("u", Date.parse("2026-11-12T00:00:00Z"), Date.parse("2026-11-13T00:00:00Z"), { timezone: "Europe/London", now: NOW });
  assert.deepEqual(j(events.map((e) => e.id)), ["ms:AAMkEarly", "ms:AAMkClientQbr="], "both pages, sorted, cancelled one gone");
  assert.ok(!events[1].attendees.includes("Me"), "your own Microsoft address (from /me) is not a guest");
  const view = seen.find((s) => s.path.startsWith("/me/calendarView"));
  assert.equal(view.prefer, 'outlook.timezone="UTC"');
  assert.match(view.path, /startDateTime=2026-11-12T00%3A00%3A00\.000Z/);

  const broken = O(async (_u, path) => (path.startsWith("/me?") ? json({}) : json({ error: { code: "ServiceUnavailable" } }, 503)));
  await assert.rejects(broken.getOutlookEventsBetween("u", 0, 1), /HTTP 503/, "a failed read is an error, never an empty day");
  assert.equal(await O(async () => null).getOutlookEventsBetween("u", 0, 1), null, "not connected");
});

// ═════════════════════════════════════════════════════════════════════════════
// Merge, de-dupe, clashes
// ═════════════════════════════════════════════════════════════════════════════

test("THE GOAL: a client's Teams invite and the team's Google meeting at 15:00 clash, and Basil catches it", () => {
  const { U } = unifiedWith();
  const events = U.mergeCalendarEvents([[gEv()], [mEv()]]);
  const clashes = U.findClashes(events, "Europe/London");
  assert.equal(clashes.length, 1);
  const [c] = clashes;
  assert.equal(c.crossProvider, true);
  assert.deepEqual(j([c.a.provider, c.b.provider]), ["google", "microsoft"]);
  assert.equal(c.a.summary, "Team sync");
  assert.equal(c.b.summary, "Client QBR");
  assert.equal(c.overlapStart, "2026-11-12T15:00:00.000Z");
  assert.equal(c.overlapEnd, "2026-11-12T15:30:00.000Z");
  assert.equal(c.label, "Thu 12 Nov 15:00–15:30 Team sync (Google Calendar) clashes with 15:00–16:00 Client QBR (Outlook calendar)");
});

test("clashes: a declined meeting, a free block, out-of-office, all-day and back-to-back meetings do not clash", () => {
  const { U } = unifiedWith();
  const none = (list) => assert.equal(U.findClashes(list, "Europe/London").length, 0, JSON.stringify(list.map((e) => e.summary)));
  none([gEv(), mEv({ myResponseStatus: "declined" })]);
  none([gEv({ myResponseStatus: "declined" }), mEv()]);
  none([gEv(), mEv({ transparent: true })]);
  none([gEv(), mEv({ eventType: "outOfOffice" })]);
  none([gEv(), mEv({ isAllDay: true, start: "2026-11-12", end: "2026-11-13" })]);
  none([gEv(), mEv({ start: "2026-11-12T15:30:00Z", end: "2026-11-12T16:00:00Z" })]);
  // Unanswered invitations still hold the time — and the label says so.
  const [c] = U.findClashes([gEv(), mEv({ myResponseStatus: "needsAction" })], "Europe/London");
  assert.match(c.label, /Client QBR \(Outlook calendar, not yet answered\)/);
  // Two Google meetings clash too; not cross-provider.
  assert.equal(U.findClashes([gEv(), gEv({ id: "g2", summary: "1:1" })], "Europe/London")[0].crossProvider, false);
});

test("merge: sorted across providers; the same meeting on both calendars is shown once", () => {
  const { U } = unifiedWith();
  const early = mEv({ id: "ms:early", summary: "Breakfast", start: "2026-11-12T08:00:00Z", end: "2026-11-12T08:30:00Z" });
  const sameUid = mEv({ id: "ms:copy", summary: "TEAM SYNC (fwd)", start: "2026-11-12T15:00:00Z", end: "2026-11-12T15:30:00Z", iCalUID: "uid-1" });
  const merged = U.mergeCalendarEvents([[gEv({ iCalUID: "UID-1" })], [early, sameUid, mEv()]]);
  assert.deepEqual(j(merged.map((e) => e.id)), ["ms:early", "g1", "ms:AAMkClientQbr="], "copy with the same iCalUID dropped, Google kept");

  const sameTitleOrganiser = mEv({ id: "ms:mirror", summary: "Team  sync", start: "2026-11-12T15:00:00Z", end: "2026-11-12T15:30:00Z", organizerEmail: "GUY@team.invalid" });
  assert.equal(U.mergeCalendarEvents([[gEv()], [sameTitleOrganiser]]).length, 1, "same times + title + organiser");
  const otherOrganiser = mEv({ id: "ms:other", summary: "Team sync", start: "2026-11-12T15:00:00Z", end: "2026-11-12T15:30:00Z", organizerEmail: "ann@client.invalid" });
  assert.equal(U.mergeCalendarEvents([[gEv()], [otherOrganiser]]).length, 2, "a different organiser is a different meeting");
  const moved = mEv({ id: "ms:moved", summary: "Team sync", organizerEmail: "guy@team.invalid", start: "2026-11-12T15:00:00Z", end: "2026-11-12T16:00:00Z" });
  assert.equal(U.mergeCalendarEvents([[gEv()], [moved]]).length, 2, "different end: not the same meeting");
});

test("one calendar read: both providers merged and tagged, with the clash and the right window", async () => {
  const { U, calls } = unifiedWith({ googleEvents: [{ ...gEv(), provider: undefined }] });
  const out = await U.readCalendar("u", { days: 14 }, "Europe/London");
  assert.deepEqual(j(out.providers), ["google", "microsoft"]);
  assert.deepEqual(j(out.degraded), []);
  assert.deepEqual(j(out.events.map((e) => [e.id, e.provider])), [["g1", "google"], ["ms:AAMkClientQbr=", "microsoft"]], "untagged Google events are tagged");
  assert.equal(out.clashes.length, 1);
  assert.deepEqual(j(calls.find((c) => c[0] === "google.days")), ["google.days", "u", 14, "Europe/London"]);
  const ms = calls.find((c) => c[0] === "ms.between");
  const today = away.dayIn(Date.now(), "Europe/London");
  assert.equal(ms[2], away.midnightIn(today, "Europe/London"));
  assert.equal(ms[3], away.midnightIn(away.addDays(today, 14), "Europe/London"));
  assert.deepEqual(j(ms[4].self.emails), ["me@team.invalid"]);

  assert.deepEqual(j(U.windowBounds({ year: 2026, month: 10 }, "Europe/London")), { startMs: Date.parse("2026-11-01T00:00:00Z"), endMs: Date.parse("2026-12-01T00:00:00Z") });
  assert.deepEqual(j(U.windowBounds({ from: "2026-10-24", to: "2026-10-25" }, "Europe/London")), { startMs: Date.parse("2026-10-23T23:00:00Z"), endMs: Date.parse("2026-10-26T00:00:00Z") });
});

test("one provider failing: the other's events come back and the failure is reported, never an empty calendar", async () => {
  const outlookDown = await unifiedWith({ outlookFails: true }).U.readCalendar("u", { date: "2026-11-12" }, "Europe/London");
  assert.deepEqual(j(outlookDown.events.map((e) => e.id)), ["g1"]);
  assert.deepEqual(j(outlookDown.providers), ["google"]);
  assert.equal(outlookDown.degraded.length, 1);
  assert.equal(outlookDown.degraded[0].provider, "microsoft");
  assert.match(outlookDown.degraded[0].error, /HTTP 503/);

  const googleDown = await unifiedWith({ googleFails: true }).U.readCalendar("u", { from: "2026-11-12", to: "2026-11-13" }, "Europe/London");
  assert.deepEqual(j(googleDown.events.map((e) => e.id)), ["ms:AAMkClientQbr="]);
  assert.deepEqual(j(googleDown.degraded.map((d) => d.provider)), ["google"]);

  const expired = await unifiedWith({ outlookEvents: null }).U.readCalendar("u", { days: 1 }, "Europe/London");
  assert.match(expired.degraded[0].error, /sign-in has expired/, "an unusable Microsoft token is reported, not read as empty");

  const googleOnly = await unifiedWith({ microsoft: false }).U.readCalendar("u", { days: 1 }, "Europe/London");
  assert.deepEqual(j(googleOnly.providers), ["google"], "Google-only users: Microsoft is not read at all");
  assert.deepEqual(j(googleOnly.degraded), []);
});

// ═════════════════════════════════════════════════════════════════════════════
// Read routes
// ═════════════════════════════════════════════════════════════════════════════

function readRoute(file, unifiedOpts) {
  const { U } = unifiedWith(unifiedOpts);
  return loadTs(file, {
    "next/server": nextServer,
    "@/lib/calendar/unified": U,
    "@/lib/auth": { getSessionUser: async () => "u" },
    "@/lib/settings/store": { getSettings: async () => ({ timezone: "Europe/London" }) },
    "@/lib/timezone": { resolveTimezone: (s) => s.timezone },
  });
}

test("upcoming route: both calendars merged, clashes and providers added, same response shape", async () => {
  const res = await readRoute("app/api/calendar/upcoming/route.ts").GET(new Request("https://basil.test/api/calendar/upcoming"));
  assert.equal(res.status, 200);
  assert.equal(res.body.connected, true);
  assert.equal(res.body.events.length, 2);
  assert.deepEqual(j(res.body.providers), ["google", "microsoft"]);
  assert.equal(res.body.clashes.length, 1);
  assert.equal(res.body.clashes[0].crossProvider, true);
  assert.match(res.body.message, /^2 events in the next 14 days\.$/);

  const partial = await readRoute("app/api/calendar/upcoming/route.ts", { outlookFails: true }).GET(new Request("https://basil.test/x"));
  assert.equal(partial.status, 200, "one calendar down is not a 500");
  assert.equal(partial.body.connected, true);
  assert.equal(partial.body.events.length, 1);
  assert.deepEqual(j(partial.body.degraded.map((d) => d.provider)), ["microsoft"]);
  assert.match(partial.body.message, /Outlook calendar could not be read/);

  const allDown = await readRoute("app/api/calendar/upcoming/route.ts", { outlookFails: true, googleFails: true }).GET(new Request("https://basil.test/x"));
  assert.equal(allDown.body.connected, false, "everything failed: the pages' old error answer, plus what failed");
  assert.equal(allDown.body.degraded.length, 2);

  const none = await readRoute("app/api/calendar/upcoming/route.ts", { google: false, microsoft: false }).GET(new Request("https://basil.test/x"));
  assert.equal(none.body.connected, false);
  assert.deepEqual(j(none.body.events), []);

  const microsoftOnly = await readRoute("app/api/calendar/month/route.ts", { google: false }).GET(new Request("https://basil.test/api/calendar/month?year=2026&month=10"));
  assert.equal(microsoftOnly.body.connected, true);
  assert.deepEqual(j(microsoftOnly.body.events.map((e) => e.provider)), ["microsoft"]);
  const today = await readRoute("app/api/calendar/route.ts").GET(new Request("https://basil.test/api/calendar"));
  assert.equal(today.body.clashes.length, 1, "the day route reports clashes too");
});

// ═════════════════════════════════════════════════════════════════════════════
// Writes go to the right provider
// ═════════════════════════════════════════════════════════════════════════════

function writesWith({ google = true, microsoft = true, outlookOrganiser = false } = {}) {
  const calls = [];
  const rec = (name, ret) => async (...a) => { calls.push([name, ...a]); return typeof ret === "function" ? ret(...a) : structuredClone(ret); };
  class NotAnAttendeeError extends Error {}
  class OutlookNotAttendeeError extends Error {}
  const W = loadTs("lib/calendar/writes.ts", {
    "@/lib/google/calendar": {
      cancelEvent: rec("google.cancel", { role: "organiser", summary: "Team sync", told: ["guy@team.invalid"], noteSent: false }),
      createCalendarEvent: rec("google.create", { id: "gnew", htmlLink: "https://calendar.google.invalid/gnew" }),
      forwardEvent: rec("google.forward", { summary: "Team sync", added: ["x@y.invalid"] }),
      formatSlot: (s, e, tz) => `${s}→${e} (${tz})`,
      NotAnAttendeeError,
      proposeNewTime: rec("google.propose", { comment: "Proposed", emailedTo: "guy@team.invalid" }),
      respondToEvent: rec("google.respond", { summary: "Team sync" }),
      updateCalendarEvent: rec("google.update", undefined),
    },
    "@/lib/google/auth": { isGoogleConnected: async () => google },
    "@/lib/microsoft/auth": { isMicrosoftConnected: async () => microsoft },
    "@/lib/microsoft/outlook-calendar": {
      isOutlookEventId: (id) => id.startsWith("ms:"),
      OutlookNotAttendeeError,
      cancelOutlookEvent: rec("ms.cancel", { role: "guest", summary: "Client QBR", told: ["ann@client.invalid"], noteSent: false }),
      createOutlookCalendarEvent: rec("ms.create", { id: "ms:new", htmlLink: "https://outlook.invalid/new" }),
      forwardOutlookEvent: rec("ms.forward", { summary: "Client QBR", added: ["x@y.invalid"] }),
      proposeOutlookNewTime: rec("ms.propose", (_u, _id, o) => { if (outlookOrganiser) throw new OutlookNotAttendeeError(); return { comment: o.comment, emailedTo: "ann@client.invalid", native: true }; }),
      respondToOutlookEvent: rec("ms.respond", () => { if (outlookOrganiser) throw new OutlookNotAttendeeError(); return { summary: "Client QBR", start: "", end: "", timeZone: "UTC", organizerIsSelf: false }; }),
      updateOutlookEvent: rec("ms.update", undefined),
    },
  });
  return { W, calls, NotAnAttendeeError, names: () => calls.map((c) => c[0]) };
}

test("writes: cancel, RSVP, propose, forward and edit act on the event's own provider", async () => {
  const w = writesWith();
  assert.equal(w.W.eventProvider("ms:AAMkClientQbr="), "microsoft");
  assert.equal(w.W.eventProvider("abc123def_20261112T150000Z"), "google", "Google ids never contain a colon");

  assert.equal((await w.W.cancelEvent("u", "ms:AAMkClientQbr=", { notify: true, note: "Sorry" })).provider, "microsoft");
  assert.equal((await w.W.cancelEvent("u", "g1", { notify: true })).provider, "google");
  await w.W.respondToEvent("u", "ms:AAMkClientQbr=", { response: "accepted" });
  await w.W.respondToEvent("u", "g1", { response: "declined" });
  await w.W.forwardEvent("u", "ms:AAMkClientQbr=", ["x@y.invalid"]);
  await w.W.updateCalendarEvent("u", "ms:AAMkClientQbr=", { startTime: "16:00" }, "America/New_York");
  await w.W.updateCalendarEvent("u", "g1", { title: "Renamed" });
  assert.deepEqual(j(w.names()), ["ms.cancel", "google.cancel", "ms.respond", "google.respond", "ms.forward", "ms.update", "google.update"]);
  assert.equal(w.calls.find((c) => c[0] === "ms.update")[4], "America/New_York", "Outlook edits know the user's zone");

  const future = new Date(Date.now() + 2 * 86_400_000).toISOString();
  const later = new Date(Date.now() + 2 * 86_400_000 + 1_800_000).toISOString();
  const out = await w.W.proposeNewTime("u", "ms:AAMkClientQbr=", { start: future, end: later, note: "after lunch?", senderName: "Fixture", timeZone: "Europe/London" });
  assert.match(out.comment, /^Proposed new time: .+ — after lunch\?$/);
  assert.equal(out.emailedTo, "ann@client.invalid");
  await assert.rejects(w.W.proposeNewTime("u", "ms:x", { start: "2020-01-01T10:00:00Z", end: "2020-01-01T10:30:00Z", senderName: "F" }), { name: "RangeError", message: /in the past/ });
  await w.W.proposeNewTime("u", "g1", { start: future, end: later, senderName: "F" });
  assert.equal(w.names().at(-1), "google.propose");
});

test("writes: an Outlook meeting you organise has no invitation to answer (409), and a disconnected provider is named", async () => {
  const w = writesWith({ outlookOrganiser: true });
  await assert.rejects(w.W.respondToEvent("u", "ms:mine", { response: "accepted" }), w.NotAnAttendeeError);
  await assert.rejects(w.W.proposeNewTime("u", "ms:mine", { start: new Date(Date.now() + 86_400_000).toISOString(), end: new Date(Date.now() + 90_000_000).toISOString(), senderName: "F" }), w.NotAnAttendeeError);

  const googleOnly = writesWith({ microsoft: false });
  await assert.rejects(googleOnly.W.cancelEvent("u", "ms:x", { notify: true }), (e) => e instanceof googleOnly.W.CalendarNotConnectedError && /Microsoft 365 calendar not connected/.test(e.message));
  assert.deepEqual(j(googleOnly.names()), [], "nothing was called");
});

test("new events go on the primary calendar: Google if connected, else Microsoft; an explicit choice wins", async () => {
  assert.equal(await writesWith().W.primaryCalendar("u"), "google");
  assert.equal(await writesWith({ google: false }).W.primaryCalendar("u"), "microsoft");
  assert.equal(await writesWith().W.primaryCalendar("u", "microsoft"), "microsoft");
  assert.equal(await writesWith({ google: false }).W.primaryCalendar("u", "google"), null);
  assert.equal(await writesWith({ google: false, microsoft: false }).W.primaryCalendar("u"), null);
  const w = writesWith({ google: false });
  const made = await w.W.createEventOn("u", "microsoft", { title: "Kickoff", attendees: ["a@x.invalid"], date: "2026-11-20", startTime: "10:00", duration: 30, timezone: "Europe/London" });
  assert.deepEqual(j(made), { id: "ms:new", htmlLink: "https://outlook.invalid/new", provider: "microsoft" });
  assert.equal(w.calls[0][2].timezone, "Europe/London");
});

test("routes: a Microsoft-only user creates on Outlook; an Outlook RSVP and cancel go through Graph", async () => {
  const w = writesWith({ google: false });
  const base = {
    "next/server": nextServer,
    "@/lib/calendar/writes": w.W,
    "@/lib/events/audit": { emitAuditEvent: async () => {} },
    "@/lib/auth": { getSessionUser: async () => "u" },
    "@/lib/settings/store": { getSettings: async () => ({ timezone: "Europe/London" }) },
    "@/lib/calendar/attendee-emails": loadTs("lib/calendar/attendee-emails.ts"),
  };
  const create = loadTs("app/api/calendar/create/route.ts", base);
  const res = await create.POST(new Request("https://basil.test/api/calendar/create", { method: "POST", body: JSON.stringify({ title: "Kickoff", date: "2026-11-20", startTime: "10:00", attendees: ["Ann Lee <ann@client.invalid>"] }) }));
  assert.equal(res.status, 200);
  assert.equal(res.body.provider, "microsoft");
  assert.equal(res.body.eventId, "ms:new");
  assert.deepEqual(j(w.calls.find((c) => c[0] === "ms.create")[2].attendees), ["ann@client.invalid"]);

  const asked = await loadTs("app/api/calendar/create/route.ts", base).POST(new Request("https://basil.test/x", { method: "POST", body: JSON.stringify({ title: "T", date: "2026-11-20", startTime: "10:00", provider: "google" }) }));
  assert.equal(asked.status, 401, "asking for a calendar that is not connected");

  const ev = { params: Promise.resolve({ eventId: "ms:AAMkClientQbr=" }) };
  const rsvp = loadTs("app/api/calendar/[eventId]/rsvp/route.ts", base);
  assert.equal((await rsvp.POST(new Request("https://basil.test/x", { method: "POST", body: JSON.stringify({ status: "tentative" }) }), ev)).status, 200);
  assert.equal(w.names().at(-1), "ms.respond");
  const byId = loadTs("app/api/calendar/[eventId]/route.ts", base);
  const del = await byId.DELETE(new Request("https://basil.test/x", { method: "DELETE" }), ev);
  assert.equal(del.status, 200);
  assert.equal(del.body.provider, "microsoft");
  assert.equal(w.names().at(-1), "ms.cancel");
  const googleId = await byId.DELETE(new Request("https://basil.test/x", { method: "DELETE" }), { params: Promise.resolve({ eventId: "g1" }) });
  assert.equal(googleId.status, 401, "a Google event while only Microsoft is connected");
});

// ═════════════════════════════════════════════════════════════════════════════
// Outlook write calls (Graph requests)
// ═════════════════════════════════════════════════════════════════════════════

function graphRecorder(handler) {
  const calls = [];
  const graphFetch = async (_u, path, init = {}) => {
    calls.push({ path, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
    if (path.startsWith("/me?")) return json({ mail: "me@ms.invalid" });
    return handler(path, init, calls);
  };
  return { calls, O: O(graphFetch), writes: () => calls.filter((c) => c.method !== "GET") };
}

test("Graph writes: create (zone, Teams link), RSVP with sendResponse, organiser cancel with the note, guest leave", async () => {
  const g = graphRecorder((path, init) => {
    if (init.method === "POST" && path === "/me/events") return json({ id: "AAMkNew", webLink: "https://outlook.office.com/calendar/item/AAMkNew" }, 201);
    if (init.method === "GET") return json({ ...CLIENT_TEAMS, isOrganizer: path.includes("Mine") });
    return json(null, 202);
  });
  const made = await g.O.createOutlookCalendarEvent("u", { title: "Late sync", attendees: ["a@x.invalid", "b@x.invalid"], date: "2026-11-12", startTime: "23:30", duration: 60, timezone: "America/New_York", addVideoCall: true });
  assert.deepEqual(j(made), { id: "ms:AAMkNew", htmlLink: "https://outlook.office.com/calendar/item/AAMkNew" });
  const body = g.calls[0].body;
  assert.deepEqual(j(body.start), { dateTime: "2026-11-12T23:30:00", timeZone: "America/New_York" });
  assert.deepEqual(j(body.end), { dateTime: "2026-11-13T00:30:00", timeZone: "America/New_York" }, "crossing midnight rolls the date");
  assert.equal(body.isOnlineMeeting, true);
  assert.deepEqual(j(body.attendees.map((a) => a.emailAddress.address)), ["a@x.invalid", "b@x.invalid"]);

  await g.O.respondToOutlookEvent("u", "ms:AAMk/Theirs=", { response: "tentative", comment: "might be late\nsorry" });
  const rsvp = g.writes().at(-1);
  assert.equal(rsvp.path, "/me/events/AAMk%2FTheirs%3D/tentativelyAccept", "ids are encoded, prefix stripped");
  assert.deepEqual(j(rsvp.body), { comment: "might be late sorry", sendResponse: true });

  const cancelled = await g.O.cancelOutlookEvent("u", "ms:AAMkMine", { notify: true, note: "Need to move this" });
  assert.equal(g.writes().at(-1).path, "/me/events/AAMkMine/cancel");
  assert.deepEqual(j(g.writes().at(-1).body), { comment: "Need to move this" });
  assert.deepEqual(j(cancelled), { role: "organiser", summary: "Client QBR", told: ["ann@client.invalid"], noteSent: true }, "you, rooms and decliners are not told");

  const left = await g.O.cancelOutlookEvent("u", "ms:AAMkTheirs", { notify: false, note: "" });
  const [decline, del] = g.writes().slice(-2);
  assert.equal(decline.path, "/me/events/AAMkTheirs/decline");
  assert.equal(decline.body.sendResponse, false, "a quiet leave");
  assert.equal(del.method, "DELETE");
  assert.equal(left.role, "guest");
  assert.deepEqual(j(left.told), []);
});

test("Graph writes: a real proposed new time, falling back to the note when the organiser disallows proposals", async () => {
  let refuse = false;
  const g = graphRecorder((path, init) => {
    if (init.method === "GET") return json(CLIENT_TEAMS);
    if (refuse && init.body && JSON.parse(init.body).proposedNewTime) return json({ error: { code: "ErrorProposedNewTimeNotSupported" } }, 400);
    return json(null, 202);
  });
  const out = await g.O.proposeOutlookNewTime("u", "ms:AAMkClientQbr=", { start: "2026-11-13T10:00:00Z", end: "2026-11-13T10:30:00Z", comment: "Proposed new time: Fri 13 Nov" });
  const sent = g.writes().at(-1);
  assert.equal(sent.path, "/me/events/AAMkClientQbr%3D/tentativelyAccept");
  assert.deepEqual(j(sent.body.proposedNewTime), { start: { dateTime: "2026-11-13T10:00:00.000", timeZone: "UTC" }, end: { dateTime: "2026-11-13T10:30:00.000", timeZone: "UTC" } });
  assert.equal(out.native, true);
  assert.equal(out.emailedTo, "ann@client.invalid");

  refuse = true;
  const fallback = await g.O.proposeOutlookNewTime("u", "ms:AAMkClientQbr=", { start: "2026-11-13T10:00:00Z", end: "2026-11-13T10:30:00Z", response: "declined", comment: "Proposed new time: Fri 13 Nov" });
  assert.equal(fallback.native, false);
  const retry = g.writes().at(-1);
  assert.equal(retry.path, "/me/events/AAMkClientQbr%3D/decline");
  assert.equal(retry.body.proposedNewTime, undefined);
  assert.equal(retry.body.comment, "Proposed new time: Fri 13 Nov");
});

test("Graph writes: editing an all-day Outlook event keeps it all-day; a timed one keeps its length", async () => {
  let current = { id: "AAMkLeave", isAllDay: true, start: { dateTime: "2026-11-20T00:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-11-22T00:00:00.0000000", timeZone: "UTC" } };
  const g = graphRecorder((_p, init) => (init.method === "GET" ? json(current) : json(null, 200)));
  await g.O.updateOutlookEvent("u", "ms:AAMkLeave", { date: "2026-11-25", startTime: "09:00", duration: 60 }, "Europe/London");
  assert.deepEqual(j(g.writes().at(-1).body), {
    isAllDay: true,
    start: { dateTime: "2026-11-25T00:00:00", timeZone: "Europe/London" },
    end: { dateTime: "2026-11-27T00:00:00", timeZone: "Europe/London" },
  });
  current = { ...CLIENT_TEAMS };
  await g.O.updateOutlookEvent("u", "ms:AAMkClientQbr=", { startTime: "17:00", title: "QBR (moved)" }, "Europe/London");
  assert.deepEqual(j(g.writes().at(-1).body), {
    subject: "QBR (moved)",
    start: { dateTime: "2026-11-12T17:00:00", timeZone: "Europe/London" },
    end: { dateTime: "2026-11-12T18:00:00", timeZone: "Europe/London" },
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Ask Basil: calendar and email tools
// ═════════════════════════════════════════════════════════════════════════════

function toolsWith({ google = true, microsoft = true, unified, writes, settings = {} } = {}) {
  const sent = [];
  const noop = new Proxy({}, { get: () => async () => ({}) });
  const outlookMail = {
    isOutlookMessageId: (id) => id.startsWith("outlook:"),
    queryOutlookMessages: async (_u, q, o) => { sent.push(["outlook.search", q, o]); return [{ id: "AAMkMsg1", from: "Ann Lee", fromEmail: "ann@client.invalid", to: "me@ms.invalid", subject: "QBR deck", snippet: "Deck attached", date: "2026-11-10T08:00:00Z", unread: true }]; },
    getOutlookMessageBody: async (_u, id, o) => { sent.push(["outlook.read", id, o]); return { from: "Ann Lee", to: "me@ms.invalid", subject: "QBR deck", date: "2026-11-10", body: "See attached." }; },
    replyToOutlookMessage: async (_u, id, body, o) => { sent.push(["outlook.reply", id, body, o]); return { id: "r1", threadId: "conv1", to: [{ name: "Ann Lee", email: "ann@client.invalid" }], cc: [] }; },
    sendOutlookEmail: async (_u, to, subject) => { sent.push(["outlook.send", to, subject]); return { id: "outlook:1" }; },
    createOutlookDraft: async (_u, to) => { sent.push(["outlook.draft", to]); return { id: "draft1" }; },
  };
  const gmail = {
    sendEmail: async (_u, to) => { sent.push(["gmail.send", to]); return { id: "g-sent" }; },
    createDraft: async (_u, to) => { sent.push(["gmail.draft", to]); return { id: "g-draft" }; },
    replyToEmail: async (_u, id) => { sent.push(["gmail.reply", id]); return { id: "g-r", threadId: "t", to: [{ name: "Guy", email: "guy@team.invalid" }], cc: [], bcc: [] }; },
    getEmailBody: async (_u, id) => { sent.push(["gmail.read", id]); return { body: "gmail body" }; },
    searchEmails: async () => { sent.push(["gmail.search"]); return [{ id: "gm1", from: "Guy", subject: "Standup", date: "2026-11-09T08:00:00Z" }]; },
    getRecentEmails: async () => [],
  };
  const mailProvider = loadTs("lib/microsoft/mail-provider.ts", {
    "@/lib/google/auth": { isGoogleConnected: async () => google },
    "./auth": { isMicrosoftConnected: async () => microsoft },
    "./outlook-mail": outlookMail,
  });
  const T = loadTs("lib/ai/tools.ts", {
    "@/lib/ai/injection-guard": loadTs("lib/ai/injection-guard.ts"),
    "@/lib/away/store": { getWorkCalendar: async () => { throw new Error("none"); }, declareAway: async () => ({}), endDeclaredAway: async () => 0, invalidateCalendarAbsences: async () => {} },
    "@/lib/away/calendar": away,
    "@/lib/glossary/store": { upsertTerm: async (_u, t) => t },
    ai, zod: require("zod"),
    "@/lib/security/sensitive": loadTs("lib/security/sensitive.ts"),
    "@/lib/web/search": noop, "@/lib/google/auth": { isGoogleConnected: async () => google },
    "@/lib/google/out-of-office": noop, "@/lib/google/gmail": gmail, "@/lib/google/drive": noop, "@/lib/slack/client": { isSlackConnected: async () => false },
    "@/lib/calendar/unified": unified ?? noop, "@/lib/calendar/writes": writes ?? noop,
    "@/lib/microsoft/mail-provider": mailProvider, "@/lib/microsoft/outlook-mail": outlookMail,
    "@/lib/memory/store": noop, "@/lib/actions/store": noop, "@/lib/decisions/store": noop,
    "@/lib/events/audit": { emitAuditEvent: async () => {} }, "@/lib/linear/sync-actions": noop, "@/lib/linear/client": noop,
    "@/lib/contacts-lookup": { findContactByName: () => undefined, timezoneFromLocation: () => undefined },
    "@/lib/contacts/user-store": { listUserContacts: async () => [] }, "@/lib/uploads/store": noop, "@/lib/uploads/search": noop,
    "@/lib/settings/store": { getSettings: async () => ({ meetingUrl: "", ...settings }) },
  });
  return { tools: T.buildAssistantTools("u", "Fixture", "Europe/London"), sent, names: () => sent.map((s) => s[0]) };
}
const run = (t, input) => t.execute(input, { toolCallId: "tc", messages: [] });

test("email tools: a Microsoft-only user sends, drafts, searches and reads through Outlook", async () => {
  const t = toolsWith({ google: false, microsoft: true });
  const sent = await run(t.tools.sendEmail, { to: "ann@client.invalid, bob@client.invalid", subject: "Deck", body: "Hi Ann" });
  assert.equal(sent.status, "sent");
  assert.equal(sent.via, "outlook");
  const draft = await run(t.tools.draftEmail, { to: "ann@client.invalid", subject: "Deck", body: "Hi" });
  assert.equal(draft.sent, false);
  assert.match(draft.note, /Outlook Drafts/);
  const found = await run(t.tools.searchEmails, { query: "from:ann@client.invalid" });
  assert.equal(found.results[0].id, "outlook:AAMkMsg1", "Outlook results carry the outlook: prefix");
  await run(t.tools.readEmail, { messageId: "outlook:AAMkMsg1" });
  assert.deepEqual(j(t.names()), ["outlook.send", "outlook.draft", "outlook.search", "outlook.read"], "Gmail never touched");
  assert.deepEqual(j(t.sent.at(-1)[2]), { text: true }, "plain-text body");
  assert.equal(t.tools.sendEmail.needsApproval, true, "the approval gate is unchanged");
  assert.equal(t.tools.replyToEmail.needsApproval, true);
});

test("email tools: with both connected Gmail sends, but a reply to an outlook: message goes from Outlook in its thread", async () => {
  const t = toolsWith();
  await run(t.tools.sendEmail, { to: "guy@team.invalid", subject: "x", body: "y" });
  const reply = await run(t.tools.replyToEmail, { messageId: "outlook:AAMkMsg1", recipients: "Ann Lee <ann@client.invalid>", body: "Thanks Ann", replyAll: true });
  assert.equal(reply.status, "sent");
  assert.deepEqual(j(reply.to), ["ann@client.invalid"]);
  assert.equal(reply.threadId, "conv1");
  await run(t.tools.replyToEmail, { messageId: "gm1", recipients: "Guy", body: "ok" });
  const search = await run(t.tools.searchEmails, { query: "QBR" });
  assert.deepEqual(j(search.results.map((r) => r.id)), ["outlook:AAMkMsg1", "gm1"], "both mailboxes, newest first");
  assert.deepEqual(j(t.names()), ["gmail.send", "outlook.reply", "gmail.reply", "gmail.search", "outlook.search"]);
  assert.deepEqual(j(t.sent[1].slice(1)), ["outlook:AAMkMsg1", "Thanks Ann", { replyAll: true }]);

  const googleOnly = toolsWith({ microsoft: false });
  const refused = await run(googleOnly.tools.replyToEmail, { messageId: "outlook:AAMkMsg1", recipients: "Ann", body: "x" });
  assert.match(refused.error, /Outlook not connected/);
  assert.deepEqual(j(googleOnly.names()), [], "never sent through the wrong mailbox");
});

test("getCalendarEvents: Ask Basil sees both calendars, the clash, and a calendar that could not be read", async () => {
  const both = await run(toolsWith({ unified: unifiedWith().U }).tools.getCalendarEvents, { date: "2026-11-12" });
  assert.equal(both.count, 2);
  assert.deepEqual(j(both.calendars), ["google", "microsoft"]);
  assert.equal(both.clashes.length, 1);
  assert.equal(both.clashes[0].clash, "Thu 12 Nov 15:00–15:30 Team sync (Google Calendar) clashes with 15:00–16:00 Client QBR (Outlook calendar)");
  assert.equal(both.clashes[0].crossProvider, true);

  const down = await run(toolsWith({ unified: unifiedWith({ outlookFails: true }).U }).tools.getCalendarEvents, { date: "2026-11-12" });
  assert.equal(down.count, 1);
  assert.match(down.warning, /Outlook calendar could not be read, so its events are MISSING/);
  assert.equal(down.clashes, undefined);

  const none = await run(toolsWith({ unified: unifiedWith({ google: false, microsoft: false }).U }).tools.getCalendarEvents, {});
  assert.match(none.error, /No calendar connected/);
});

test("B5 checkAttendeeAvailability: an unreadable calendar is unknown, not free; slots use the user's working hours", async () => {
  const down = await run(toolsWith({ unified: unifiedWith({ outlookFails: true }).U }).tools.checkAttendeeAvailability, { attendees: ["ann@client.invalid"], date: "2026-11-12" });
  assert.equal(down.calendarUnavailable, true);
  assert.equal(down.suggestedSlots, undefined, "no slots suggested over meetings it could not see");
  assert.match(down.error, /Outlook calendar/);

  // Working 12:00–14:00, a meeting 12:30–13:00 and a declined one 13:00–13:30.
  const unified = unifiedWith({
    googleEvents: [gEv({ start: "2026-11-12T12:30:00Z", end: "2026-11-12T13:00:00Z" }), gEv({ id: "g2", start: "2026-11-12T13:00:00Z", end: "2026-11-12T13:30:00Z", myResponseStatus: "declined" })],
    outlookEvents: [],
  }).U;
  const ok = await run(toolsWith({ unified, settings: { workStart: "12:00", workEnd: "14:00" } }).tools.checkAttendeeAvailability, { attendees: ["ann@client.invalid"], date: "2026-11-12" });
  assert.equal(ok.you.workingHours, "12:00–14:00");
  assert.deepEqual(j(ok.suggestedSlots.map((s) => s.slice(0, 5))), ["12:00", "13:00", "13:30"], "inside 12:00–14:00, around the meeting; the declined one does not block");
  assert.match(ok.you.note, /Google Calendar and Outlook calendar/);
});

test("scheduleMeeting: books on Outlook for a Microsoft-only user, or on the calendar asked for", async () => {
  const w = writesWith({ google: false });
  const res = await run(toolsWith({ google: false, writes: w.W }).tools.scheduleMeeting, { title: "Kickoff", attendees: ["ann@client.invalid"], date: "2026-11-20", startTime: "10:00", duration: 30 });
  assert.equal(res.status, "meeting_scheduled");
  assert.equal(res.calendar, "microsoft");
  assert.equal(res.eventId, "ms:new");
  assert.equal(w.calls[0][0], "ms.create");
  assert.equal(w.calls[0][2].timezone, "Europe/London");

  const both = writesWith();
  await run(toolsWith({ writes: both.W }).tools.scheduleMeeting, { title: "Client call", attendees: ["ann@client.invalid"], date: "2026-11-20", startTime: "10:00", duration: 30, calendar: "microsoft" });
  assert.equal(both.calls[0][0], "ms.create");
  await run(toolsWith({ writes: both.W }).tools.scheduleMeeting, { title: "Team call", attendees: ["guy@team.invalid"], date: "2026-11-20", startTime: "11:00", duration: 30 });
  assert.equal(both.calls[1][0], "google.create", "Google stays the primary calendar");
});

test("Outlook mail helpers: comma-separated and named recipients; the mailbox chooser", () => {
  const M = loadTs("lib/microsoft/outlook-mail.ts", { "./auth": { graphGet: async () => null, graphFetch: async () => null } });
  assert.deepEqual(j(M.toRecipients('ann@client.invalid, "Lee, Bob" <bob@client.invalid>; carl@x.invalid')), [
    { emailAddress: { address: "ann@client.invalid" } },
    { emailAddress: { address: "bob@client.invalid", name: "Lee, Bob" } },
    { emailAddress: { address: "carl@x.invalid" } },
  ]);
  const P = loadTs("lib/microsoft/mail-provider.ts", { "@/lib/google/auth": {}, "./auth": {}, "./outlook-mail": M });
  assert.equal(P.pickMailProvider({ google: true, microsoft: true }), "google");
  assert.equal(P.pickMailProvider({ google: false, microsoft: true }), "microsoft");
  assert.equal(P.pickMailProvider({ google: true, microsoft: true }, "outlook:AAMk"), "microsoft");
  assert.equal(P.pickMailProvider({ google: true, microsoft: false }, "outlook:AAMk"), null);
  assert.equal(P.pickMailProvider({ google: false, microsoft: false }), null);
});

// ═════════════════════════════════════════════════════════════════════════════
// B10 — a failed Microsoft refresh no longer kills the connection
// ═════════════════════════════════════════════════════════════════════════════

function msAuth(stored, fetchImpl) {
  const saved = [];
  let current = structuredClone(stored);
  const A = loadTs("lib/microsoft/auth.ts", {
    "@/lib/storage/secure-token-store": {
      getIntegrationToken: async () => (current ? structuredClone(current) : null),
      saveIntegrationToken: async (_u, _p, t) => { saved.push(structuredClone(t)); current = structuredClone(t); },
    },
  }, { MICROSOFT_CLIENT_ID: "client", MICROSOFT_CLIENT_SECRET: "secret" }, { fetch: fetchImpl });
  return { A, saved, now: () => current };
}
const tokenOk = () => json({ access_token: "fresh-token", refresh_token: "rt-2", expires_in: 3600, scope: "Mail.Read Calendars.ReadWrite", token_type: "Bearer" });

test("B10: a blank access token with a refresh token is still read, and the refresh is tried", async () => {
  let tokenCalls = 0;
  const m = msAuth({ access_token: "", refresh_token: "rt-1", expires_at: 0, scope: "Calendars.ReadWrite", token_type: "Bearer" },
    async (url) => { tokenCalls++; assert.match(String(url), /login\.microsoftonline\.com/); return tokenOk(); });
  assert.equal((await m.A.getStoredTokens("u")).refresh_token, "rt-1", "used to be null, so the refresh token was never tried again");
  assert.equal(await m.A.getAccessToken("u"), "fresh-token");
  assert.equal(tokenCalls, 1);
  assert.equal(m.now().refresh_token, "rt-2");
});

test("B10: a temporary refresh failure leaves the stored token alone; only invalid_grant/invalid_client blanks it", async () => {
  const valid = { access_token: "old-token", refresh_token: "rt-1", expires_at: Date.now() + 3_600_000, scope: "Calendars.ReadWrite", token_type: "Bearer" };
  // Graph says 401 (token revoked server-side) → force refresh → Microsoft 503.
  const blip = msAuth(valid, async (url) => (String(url).includes("login.microsoftonline.com") ? json({ error: "temporarily_unavailable" }, 503) : json({}, 401)));
  const res = await blip.A.graphFetch("u", "/me/events");
  assert.equal(res.status, 401);
  assert.deepEqual(j(blip.saved), [], "nothing written: the token and refresh token survive a blip");
  assert.equal((await blip.A.getStoredTokens("u")).access_token, "old-token");

  let tokenCalls = 0;
  const revoked = msAuth(valid, async (url) => {
    if (!String(url).includes("login.microsoftonline.com")) return json({}, 401);
    tokenCalls++;
    return json({ error: "invalid_grant", error_description: "AADSTS700082: The refresh token has expired" }, 400);
  });
  await revoked.A.graphFetch("u", "/me/events");
  assert.equal(revoked.saved.length, 1);
  assert.equal(revoked.saved[0].access_token, "", "re-authorise prompt");
  assert.equal(revoked.saved[0].expires_at, 0);
  assert.equal(revoked.saved[0].refresh_token, "rt-1", "the refresh token is kept");
  assert.ok(await revoked.A.getStoredTokens("u"), "the record is still read");
  assert.equal(await revoked.A.getAccessToken("u"), null);
  assert.equal(tokenCalls, 2, "and the refresh is tried again next time");

  assert.equal(revoked.A.isPermanentRefreshFailure(400, '{"error":"invalid_client"}'), true);
  assert.equal(revoked.A.isPermanentRefreshFailure(400, '{"error":"temporarily_unavailable"}'), false);
  assert.equal(revoked.A.isPermanentRefreshFailure(503, ""), false);
  assert.equal(revoked.A.isPermanentRefreshFailure(429, '{"error":"invalid_grant"}'), false);
});

test("isMicrosoftConnected: needs a token record, and the scope for the service when one is named", async () => {
  const withScope = (scope) => msAuth({ access_token: "t", refresh_token: "r", expires_at: Date.now() + 3_600_000, scope, token_type: "Bearer" }, async () => json({}));
  assert.equal(await withScope("openid Mail.Read Mail.Send Calendars.ReadWrite").A.isMicrosoftConnected("u", "calendar"), true);
  assert.equal(await withScope("openid Mail.Read").A.isMicrosoftConnected("u", "calendar"), false);
  assert.equal(await withScope("openid Mail.Read").A.isMicrosoftConnected("u", "mail"), true);
  assert.equal(await withScope("").A.isMicrosoftConnected("u", "calendar"), true, "no scope recorded: not hidden");
  assert.equal(await msAuth(null, async () => json({})).A.isMicrosoftConnected("u"), false);
});

// ═════════════════════════════════════════════════════════════════════════════
// B7 — moved and cancelled Outlook meetings reach Basil
// ═════════════════════════════════════════════════════════════════════════════

test("B7: the Outlook calendar webhook stores each new version of a meeting, skips redeliveries", async () => {
  const created = [];
  const ids = new Set();
  let ev = { id: "AAMk1", subject: "Client QBR", start: { dateTime: "2026-11-12T15:00:00.0000000" }, end: { dateTime: "2026-11-12T16:00:00.0000000" }, organizer: { emailAddress: { name: "Ann Lee" } }, attendees: [], isOnlineMeeting: true, lastModifiedDateTime: "2026-11-10T09:00:00Z" };
  const route = loadTs("app/api/webhooks/microsoft/calendar/route.ts", {
    "next/server": nextServer,
    "@/lib/microsoft/auth": { graphGet: async () => structuredClone(ev) },
    "@/lib/microsoft/watch-state": { getWatchState: async () => ({ calendar: { clientState: "s3cret" } }) },
    "@/lib/events/store": {
      hasExternalId: async (_u, id) => ids.has(id),
      createEvent: async (_u, e) => { created.push(e); ids.add(e.externalId); return e; },
    },
    "@/lib/events/rules": { eventFromIngest: (p) => ({ externalId: p.externalId, title: p.title }) },
    "@/lib/events/bus": { publish: () => {} },
    "@/lib/webhooks/resolve-user": { resolveMicrosoftSubscriptionUser: async () => "u" },
    "@/lib/webhooks/dead-letter": { writeDeadLetter: async () => {} },
    "@/lib/microsoft/outlook-calendar": O(),
  });
  const notify = () => route.POST(new Request("https://basil.test/api/webhooks/microsoft/calendar", {
    method: "POST",
    body: JSON.stringify({ value: [{ subscriptionId: "sub1", changeType: "updated", clientState: "s3cret", resource: "me/events/AAMk1", resourceData: { id: "AAMk1" } }] }),
  }));

  await notify();
  await notify();
  assert.equal(created.length, 1, "a redelivery of the same version is skipped");

  ev = { ...ev, start: { dateTime: "2026-11-12T17:00:00.0000000" }, end: { dateTime: "2026-11-12T18:00:00.0000000" }, lastModifiedDateTime: "2026-11-10T11:00:00Z" };
  await notify();
  assert.equal(created.length, 2, "moved: used to be skipped forever");

  ev = { ...ev, isCancelled: true, lastModifiedDateTime: "2026-11-10T12:00:00Z" };
  await notify();
  assert.equal(created.length, 3);
  assert.equal(created[2].title, "Cancelled: Client QBR");
  assert.equal(created[0].externalId, "outlook-cal:AAMk1@2026-11-10T09:00:00Z");
  assert.equal(O().outlookChangeKey("ms:AAMk1", { start: { dateTime: "a" }, end: { dateTime: "b" }, isCancelled: true }), "outlook-cal:AAMk1@a|b|cancelled");
});

// ═════════════════════════════════════════════════════════════════════════════
// B5 — the free/busy route
// ═════════════════════════════════════════════════════════════════════════════

function freebusyRoute(unifiedOpts, settings) {
  const u = unifiedWith(unifiedOpts);
  const route = loadTs("app/api/calendar/freebusy/route.ts", {
    "next/server": nextServer,
    "@/lib/auth": { getSessionUser: async () => "u" },
    "@/lib/calendar/unified": u.U,
    "@/lib/calendar/find-slots": loadTs("lib/calendar/find-slots.ts", { "@/lib/calendar/unified": u.U }),
    "@/lib/away/calendar": away,
    "@/lib/contacts/user-store": { listUserContacts: async () => [] },
    "@/lib/contacts-lookup": { findContactByName: () => undefined },
    "@/lib/settings/store": { getSettings: async () => settings },
    "@/lib/timezone": { resolveTimezone: (s) => s.timezone },
  });
  return { route, calls: u.calls };
}
const fbReq = (body) => new Request("https://basil.test/api/calendar/freebusy", { method: "POST", body: JSON.stringify(body) });

test("B5 freebusy route: no slots when the calendar cannot be read; local days; the user's working hours", async () => {
  const tokyo = { timezone: "Asia/Tokyo", workStart: "10:00", workEnd: "12:00" };
  const window = { attendeeEmails: ["ann@client.invalid"], windowStart: "2026-11-12T16:00:00Z", windowEnd: "2026-11-13T08:00:00Z" };

  const down = await freebusyRoute({ outlookFails: true }, tokyo).route.POST(fbReq(window));
  assert.equal(down.body.calendarUnavailable, true);
  assert.deepEqual(j(down.body.slots), []);
  assert.deepEqual(j(down.body.degraded.map((d) => d.provider)), ["microsoft"]);

  const ok = freebusyRoute({ googleEvents: [], outlookEvents: [] }, tokyo);
  const res = await ok.route.POST(fbReq(window));
  assert.deepEqual(j(ok.calls.find((c) => c[0] === "google.range")), ["google.range", "u", "2026-11-13", "2026-11-13", "Asia/Tokyo"],
    "01:00 on the 13th in Tokyo is the 13th, not the UTC 12th");
  assert.deepEqual(j(res.body.slots.map((s) => s.start)), ["2026-11-13T01:00:00.000Z", "2026-11-13T01:30:00.000Z", "2026-11-13T02:00:00.000Z", "2026-11-13T02:30:00.000Z"],
    "10:00–12:00 Tokyo only (settings), not 09:00–17:00");

  const S = loadTs("lib/calendar/find-slots.ts", { "@/lib/calendar/unified": {} });
  assert.equal(S.hoursFromHHMM("09:30", 9), 9.5);
  assert.equal(S.hoursFromHHMM("nonsense", 17), 17);
});

// ═════════════════════════════════════════════════════════════════════════════
// Google: B11 all-day edits, tzDayBounds, paging
// ═════════════════════════════════════════════════════════════════════════════

function googleCal({ list, event } = {}) {
  const calls = { list: [], patch: [] };
  const cal = {
    events: {
      list: async (p) => { calls.list.push(p); return list(p); },
      get: async () => ({ data: structuredClone(event) }),
      patch: async (p) => { calls.patch.push(p); return { data: {} }; },
    },
  };
  const C = loadTs("lib/google/calendar.ts", {
    googleapis: { google: { calendar: () => cal } },
    "./auth": { getAuthedClient: async () => ({}) },
    "./gmail": { sendEmail: async () => ({ id: "m" }) },
    "@/lib/self-identity": { getSelfIdentity: async () => ({ emails: [], names: [] }), stripSelf: (a) => a },
    "@/lib/away/calendar": away,
  });
  return { C, calls };
}

test("B11: editing an all-day Google event moves its dates and keeps it all-day", async () => {
  const g = googleCal({ event: { summary: "Offsite", start: { date: "2026-11-20" }, end: { date: "2026-11-22" } } });
  await g.C.updateCalendarEvent("u", "e1", { date: "2026-11-25", startTime: "09:00", duration: 60 });
  assert.deepEqual(j(g.calls.patch[0].requestBody), { start: { date: "2026-11-25" }, end: { date: "2026-11-27" } }, "no dateTime: not a 24-hour timed block");
  await g.C.updateCalendarEvent("u", "e1", { title: "Team offsite" });
  assert.deepEqual(j(g.calls.patch[1].requestBody), { summary: "Team offsite" });

  const timed = googleCal({ event: { summary: "Sync", start: { dateTime: "2026-11-20T10:00:00Z", timeZone: "Europe/London" }, end: { dateTime: "2026-11-20T11:00:00Z", timeZone: "Europe/London" } } });
  await timed.C.updateCalendarEvent("u", "e2", { startTime: "14:00" });
  assert.deepEqual(j(timed.calls.patch[0].requestBody), { start: { dateTime: "2026-11-20T14:00:00", timeZone: "Europe/London" }, end: { dateTime: "2026-11-20T15:00:00", timeZone: "Europe/London" } });
});

test("tzDayBounds: midnight on the clock-change days is read with the midnight offset, not noon's", () => {
  const { C } = googleCal();
  const autumn = C.tzDayBounds("2026-10-25", "Europe/London");
  assert.equal(autumn.start.toISOString(), "2026-10-24T23:00:00.000Z", "00:00 BST (the noon offset gave 00:00Z, an hour late)");
  assert.equal(autumn.end.toISOString(), "2026-10-25T23:59:59.000Z");
  const spring = C.tzDayBounds("2026-03-29", "Europe/London");
  assert.equal(spring.start.toISOString(), "2026-03-29T00:00:00.000Z", "00:00 GMT (the noon offset gave 23:00Z the day before)");
  assert.equal(spring.end.toISOString(), "2026-03-29T22:59:59.000Z");
  assert.equal(C.tzDayBounds("2026-11-12", "America/New_York").start.toISOString(), "2026-11-12T05:00:00.000Z");
});

test("Google reads page through nextPageToken, and every event is tagged google", async () => {
  const page1 = { items: [{ id: "a", summary: "One", start: { dateTime: "2026-11-12T09:00:00Z" }, end: { dateTime: "2026-11-12T09:30:00Z" }, iCalUID: "uid-a" }], nextPageToken: "p2" };
  const page2 = { items: [{ id: "b", summary: "Two", start: { dateTime: "2026-11-12T10:00:00Z" }, end: { dateTime: "2026-11-12T10:30:00Z" }, transparency: "transparent" }] };
  const g = googleCal({ list: (p) => ({ data: p.pageToken === "p2" ? page2 : page1 }) });
  const events = await g.C.getEventsForDate("u", "2026-11-12", "Europe/London");
  assert.deepEqual(j(events.map((e) => e.id)), ["a", "b"], "the old single page of 50 dropped the rest");
  assert.equal(g.calls.list[1].pageToken, "p2");
  assert.deepEqual(j(events.map((e) => e.provider)), ["google", "google"]);
  assert.equal(events[0].iCalUID, "uid-a");
  assert.equal(events[1].transparent, true);
  for (const fn of [() => g.C.getEventsForDateRange("u", "2026-11-12", "2026-11-13"), () => g.C.getEventsForDays("u", 7), () => g.C.getEventsForMonth("u", 2026, 10)]) {
    g.calls.list.length = 0;
    assert.equal((await fn()).length, 2);
    assert.equal(g.calls.list.length, 2);
  }
});
