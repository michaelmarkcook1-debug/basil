// Out of office from Ask Basil (lib/google/out-of-office.ts, lib/ai/tools.ts).
// On 2026-11-03 Michael asked Basil to set his auto-reply for a trip and
// "prove it's been actioned"; Basil had no way to and handed back Gmail steps.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadTs } from "./_helpers/load-ts.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const SETTINGS = "https://www.googleapis.com/auth/gmail.settings.basic";

/** A fake Gmail + Calendar that stores what it is given and returns it on read. */
function load({ scopes = [SETTINGS], failWith = null } = {}) {
  const calls = [];
  let vacation = { enableAutoReply: false };
  const events = new Map();
  const google = {
    gmail: () => ({ users: { settings: {
      updateVacation: async (a) => { calls.push(["updateVacation", a]); if (failWith) throw failWith; vacation = { ...a.requestBody }; return { data: vacation }; },
      getVacation: async () => ({ data: vacation }),
    } } }),
    calendar: () => ({ events: {
      insert: async (a) => { calls.push(["insert", a]); const id = "ooo1"; events.set(id, { id, htmlLink: "https://cal/ooo1", ...a.requestBody }); return { data: { id } }; },
      get: async ({ eventId }) => ({ data: events.get(eventId) }),
    } }),
  };
  const O = loadTs("lib/google/out-of-office.ts", {
    googleapis: { google },
    "./auth": { getAuthedClient: async () => ({}), getGrantedScopes: async () => scopes, GOOGLE_SCOPE: { gmailSettings: SETTINGS } },
  });
  return { O, calls };
}

const TRIP = { start: "2026-11-03", end: "2026-11-13", subject: "Out of office", message: "Back 16 Nov. Guy Saunders (guy@talentgenius.io) can help meanwhile.", timezone: "Europe/London" };

test("the window runs from the first day's midnight to the midnight after the last day, in the user's zone", () => {
  const { O } = load();
  const w = O.vacationWindow("2026-11-03", "2026-11-13", "Europe/London");
  assert.equal(new Date(w.startMs).toISOString(), "2026-11-03T00:00:00.000Z");
  assert.equal(new Date(w.endMs).toISOString(), "2026-11-14T00:00:00.000Z");
  const ny = O.vacationWindow("2026-07-01", "2026-07-01", "America/New_York");
  assert.equal(new Date(ny.startMs).toISOString(), "2026-07-01T04:00:00.000Z", "summer time");
  assert.throws(() => O.vacationWindow("2026-11-13", "2026-11-03", "Europe/London"), /before the first day/);
});

test("it turns the auto-reply on and reports what Gmail holds, read back, as the proof", async () => {
  const { O, calls } = load();
  const s = await O.setOutOfOffice("michael", { ...TRIP, start: "2099-11-03", end: "2099-11-13" });
  const sent = calls.find(([k]) => k === "updateVacation")[1].requestBody;
  assert.equal(sent.enableAutoReply, true);
  assert.equal(sent.responseBodyPlainText, TRIP.message);
  assert.equal(s.autoReplyOn, true);
  assert.equal(s.firstDay, "2099-11-03");
  assert.equal(s.lastDay, "2099-11-13", "the last day is inclusive");
  assert.equal(s.subject, "Out of office");
  assert.equal(s.calendarBlock, undefined, "no calendar block unless asked");
});

test("the optional calendar block is an Out-of-office event that declines new invites, also read back", async () => {
  const { O, calls } = load();
  const s = await O.setOutOfOffice("michael", { ...TRIP, start: "2099-11-03", end: "2099-11-13", blockCalendar: true });
  const ev = calls.find(([k]) => k === "insert")[1].requestBody;
  assert.equal(ev.eventType, "outOfOffice");
  assert.equal(ev.outOfOfficeProperties.autoDeclineMode, "declineOnlyNewConflictingInvitations");
  assert.equal(s.calendarBlock.id, "ooo1");
  assert.equal(s.calendarBlock.htmlLink, "https://cal/ooo1");
});

test("without the Gmail settings permission it says to reconnect Google, and nothing is written", async () => {
  const { O, calls } = load({ scopes: ["https://www.googleapis.com/auth/gmail.modify"] });
  await assert.rejects(O.setOutOfOffice("michael", { ...TRIP, start: "2099-11-03", end: "2099-11-13" }), /Reconnect Google in Settings/);
  assert.equal(calls.length, 0);
  const denied = load({ failWith: Object.assign(new Error("Request had insufficient authentication scopes."), { code: 403 }) });
  await assert.rejects(denied.O.setOutOfOffice("michael", { ...TRIP, start: "2099-11-03", end: "2099-11-13" }), /Reconnect Google/);
});

test("dates already over are refused; turning it off is read back too", async () => {
  const { O } = load();
  await assert.rejects(O.setOutOfOffice("michael", { ...TRIP, start: "2020-01-01", end: "2020-01-02" }), /already over/);
  await O.setOutOfOffice("michael", { ...TRIP, start: "2099-11-03", end: "2099-11-13" });
  assert.equal((await O.clearOutOfOffice("michael", "Europe/London")).autoReplyOn, false);
});

test("Ask Basil has the tools, asks before changing anything, and is told it can do this", () => {
  const t = src("lib/ai/tools.ts");
  assert.match(t, /setOutOfOffice: tool\(\{/);
  assert.match(t, /needsApproval: !delegated\.has\("setOutOfOffice"\)/);
  assert.match(t, /checkOutOfOffice: tool\(\{/);
  assert.match(t, /needsApproval: !delegated\.has\("turnOffOutOfOffice"\)/);
  assert.match(t, /verifiedFromGoogle: state/);
  assert.match(src("lib/ai/system-prompt.ts"), /You CAN do this — never hand \$\{firstName\} manual Gmail steps/);
  assert.match(src("lib/google/auth.ts"), /"https:\/\/www\.googleapis\.com\/auth\/gmail\.settings\.basic",/);
  assert.match(src("app/dashboard/chat/page.tsx"), /case "setOutOfOffice": \{/);
});
