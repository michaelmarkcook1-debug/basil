// The 2026-11-10 bug pass (basil-bug-pass-2026-11-10.md): ten confirmed bugs,
// each read in the code before it was fixed.
//  1. Slack/Teams webhook ingest recorded the hash of a FAILED classification,
//     so an AI outage wrote the message off for good.
//  2. A failed Zoom extraction looked like "confidence 0" and was recorded too;
//     an upload whose extraction failed reported "nothing to file".
//  3. The morning reprocess re-classified quiet threads every day for 14 days,
//     and never looked at Teams rows stored as source:"teams".
//  4. Day view: guests picked from contacts were dropped on create, every edit
//     with a guest failed (names sent as addresses), failures looked like
//     success, and one click on the bin cancelled a meeting for everyone.
//  5. The cancel dialog carried an abandoned note to the next meeting.
//  6. The Pro trial could be restarted forever once it expired.
//  7. Invited colleagues were on Free, so the briefing the invite promises
//     never came.
//  8. The nightly backup returned 200 and pruned when copies had failed.
//  9. Ask Basil's "draft a profile" fetched its own route with no session: 401.
// 10. Zoom connect's return path let "/\evil.com" through, and Zoom/Microsoft
//     errors were hidden behind the no-code return.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadTs, nextServer } from "./_helpers/load-ts.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
// Values built inside the sandbox have its own Object/Array, so compare as plain data.
const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** A module whose named exports are given, and anything else is a harmless async no-op. */
const loose = (exports = {}) => new Proxy(exports, {
  get: (t, k) => (k in t ? t[k] : k === "__esModule" ? undefined : async () => ({})),
});
/** Mocks for a module with many imports: the listed ones as given, every other import loose. */
const looseMocks = (given) => new Proxy(given, {
  getOwnPropertyDescriptor: (t, k) => Object.getOwnPropertyDescriptor(t, k) ?? { value: loose(), configurable: true, enumerable: true, writable: true },
  get: (t, k) => (k in t ? t[k] : loose()),
});

// ── 1. Webhook ingest: a failed classification is not recorded ───────────────

function ingest({ failed }) {
  const recorded = [];
  const intel = { category: "fyi", confidence: 0, actions: [], decisions: [], ...(failed ? { classificationFailed: true } : {}) };
  const classify = async () => intel;
  const mocks = {
    workflow: { FatalError: class FatalError extends Error {} },
    "./store": { updateJobRecord: async () => {} },
    "@/lib/ingest/content-hash": { hashContent: () => "hash-1" },
    "@/lib/ingest/index": { isHashUnchanged: async () => false, recordIngest: async (_u, r) => { recorded.push(r); } },
    "@/lib/ingest/audit-log": { appendAuditEntries: async () => {}, auditSkipped: () => ({}) },
    "@/lib/self-identity": { getSelfIdentity: async () => ({ emails: [], names: [] }) },
    "@/lib/slack/fetch-thread": { fetchSlackThread: async () => [], formatThreadTranscript: () => "" },
    "@/lib/slack/classify-slack": { classifySlack: classify, shouldMaterializeSlack: () => false },
    "@/lib/slack/materialize-slack": { materializeSlackIntelligence: async () => { throw new Error("nothing to materialize"); } },
    "@/lib/teams/fetch-thread": { fetchTeamsThread: async () => [], formatTeamsTranscript: () => "" },
    "@/lib/teams/classify-teams": { classifyTeams: classify, shouldMaterializeSlack: () => false },
    "@/lib/teams/materialize-teams": { materializeTeamsIntelligence: async () => { throw new Error("nothing to materialize"); } },
  };
  return { mocks, recorded };
}
const SLACK = { channelId: "C1", messageTs: "1.2", externalId: "slack:C1:1.2", eventId: "e1", channelName: "general", from: "Guy", date: "2026-11-10T09:00:00Z", isDM: false, isMention: false, bodyFallback: "hi" };
const TEAMS = { chatOrChannelId: "chat1", channelId: null, messageId: "m1", externalId: "teams:chat1:m1", eventId: "e2", channelName: "Ops", from: "Ed", date: "2026-11-10T09:00:00Z", isDM: false, isMention: false, bodyFallback: "hi" };

test("1. Slack and Teams webhook workflows leave a FAILED classification unrecorded, but record a real 'nothing here'", async () => {
  for (const failed of [true, false]) {
    const s = ingest({ failed });
    await loadTs("lib/jobs/workflows/ingest-slack.ts", s.mocks).ingestSlackWorkflow("michael", SLACK);
    assert.equal(s.recorded.length, failed ? 0 : 1, `slack workflow, failed=${failed}`);
    const t = ingest({ failed });
    await loadTs("lib/jobs/workflows/ingest-teams.ts", t.mocks).ingestTeamsWorkflow("michael", TEAMS);
    assert.equal(t.recorded.length, failed ? 0 : 1, `teams workflow, failed=${failed}`);
  }
});

test("1. the job executor's Slack and Teams handlers follow the same rule", async () => {
  for (const failed of [true, false]) {
    const s = ingest({ failed });
    await loadTs("lib/jobs/executor.ts", s.mocks).executeJob("ingest.slack", "michael", SLACK, "job1");
    assert.equal(s.recorded.length, failed ? 0 : 1, `executor slack, failed=${failed}`);
    const t = ingest({ failed });
    await loadTs("lib/jobs/executor.ts", t.mocks).executeJob("ingest.teams", "michael", TEAMS, "job2");
    assert.equal(t.recorded.length, failed ? 0 : 1, `executor teams, failed=${failed}`);
  }
});

test("1. classifyTeams passes classifySlack's failure flag through", async () => {
  const T = loadTs("lib/teams/classify-teams.ts", {
    "@/lib/slack/classify-slack": { classifySlack: async (i) => ({ channelName: i.channelName, classificationFailed: true }) },
  });
  const r = await T.classifyTeams({ username: "michael", channelName: "Ops", transcript: "", isDM: false, isMention: false, date: "" });
  assert.equal(r.classificationFailed, true);
  assert.equal(r.channelName, "Teams: Ops");
});

// ── 2. Zoom recap extraction failure ──────────────────────────────────────────

function extractor(generateTextSafe) {
  return loadTs("lib/zoom/extract-meeting.ts", {
    "@/lib/ai/generate": { generateTextSafe },
    "@/lib/ai/model-config": { getTextModel: () => "m", MAX_TOKENS: { long: 8192 } },
    "@/lib/ai/pricing": { familyForTier: () => "luna" },
    "@/lib/ai/system-prompt": { getTaskSystemPrompt: async () => "sys" },
    "@/lib/ai/parse-json": { parseAndValidate: () => ({ ok: false, error: "not JSON" }) },
    "@/lib/ai/schemas": { ZoomMeetingExtractSchema: {} },
  });
}

test("2. a model or parse error comes back flagged failed; an empty email does not", async () => {
  const down = await extractor(async () => { throw new Error("provider down"); }).extractZoomMeeting("Notes", { subject: "Weekly", date: "2026-11-10" }, "michael");
  assert.equal(down.failed, true);
  assert.equal(down.confidence, 0);
  const garbled = await extractor(async () => ({ text: "garbled" })).extractZoomMeeting("Notes", { subject: "Weekly", date: "2026-11-10" }, "michael");
  assert.equal(garbled.failed, true, "an unparseable answer is a failure too");
  const empty = await extractor(async () => { throw new Error("must not be called"); }).extractZoomMeeting("  ", { subject: "Weekly", date: "2026-11-10" }, "michael");
  assert.equal(empty.failed, undefined, "nothing to read is not an AI failure");
});

function zoomProcessor(extract) {
  const recorded = [];
  const P = loadTs("lib/email/process-gmail-message.ts", looseMocks({
    "@/lib/zoom/extract-meeting": { extractZoomMeeting: async () => extract },
    "@/lib/ingest/index": loose({ isHashUnchanged: async () => false, recordIngest: async (_u, r) => { recorded.push(r); } }),
    "@/lib/ingest/content-hash": loose({ hashContent: () => "zoom-hash" }),
    "@/lib/self-identity": loose({ getSelfIdentity: async () => ({ emails: [], names: ["Michael"] }), selfInContext: () => ({ emails: [], names: ["Michael"] }) }),
    "@/lib/contacts/user-store": loose({ listUserContacts: async () => [] }),
    "@/lib/trust/policy": loose({ ZOOM_REVIEW_FLOOR: 0.4 }),
    "@/lib/ingest/audit-log": loose({ appendAuditEntries: async () => {}, auditFailed: () => ({}), auditSkipped: () => ({}) }),
  }));
  return { P, recorded };
}
const EMPTY_EXTRACT = { meetingTitle: "Weekly", meetingDate: "2026-11-10", attendees: [], summary: "", actionItems: [], decisions: [], blockers: [], followUps: [], topics: [], toneShifts: [], confidence: 0 };
const ZOOM_OPTS = { username: "michael", gmailId: "", externalId: "gmail:z1", eventId: "e1", subject: "Weekly", dateFallback: "2026-11-10", body: "Notes from the call" };

test("2. processZoomEmail does not record a failed extraction, and says so; a real low-confidence one is still recorded", async () => {
  const failed = zoomProcessor({ ...EMPTY_EXTRACT, failed: true });
  assert.deepEqual(plain(await failed.P.processZoomEmail(ZOOM_OPTS)), { extractionFailed: true });
  assert.equal(failed.recorded.length, 0, "left unrecorded so the reprocess pass retries it");

  const thin = zoomProcessor(EMPTY_EXTRACT);
  assert.equal(await thin.P.processZoomEmail(ZOOM_OPTS), undefined);
  assert.equal(thin.recorded.length, 1, "below the floor is a verdict — recorded as before");
});

test("2. an upload whose extraction failed is a failed upload, not 'nothing clear enough to file'", () => {
  const u = src("lib/uploads/process.ts");
  assert.match(u, /const outcome = await processZoomEmail\(/);
  assert.match(u, /if \(outcome\?\.extractionFailed\) \{\s*throw new Error\(/);
  // The throw lands in the existing catch, which marks the upload failed.
  assert.match(u, /await patchUpload\(username, id, \{ status: "failed", detail: msg \}\)/);
});

// ── 3. Morning reprocess ──────────────────────────────────────────────────────

async function reprocess(events, intel) {
  const recorded = [];
  const queued = [];
  const route = loadTs("app/api/events/reprocess/route.ts", {
    "next/server": { NextResponse: nextServer.NextResponse, after: (fn) => queued.push(fn) },
    "@/lib/events/store": { listEvents: async () => events },
    "@/lib/actions/store": { listActions: async () => [] },
    "@/lib/decisions/store": { listDecisions: async () => [] },
    "@/lib/email/process-gmail-message": { processRegularEmail: async () => {}, processZoomEmail: async () => {} },
    "@/lib/microsoft/outlook-mail": { getOutlookMessageBody: async () => "" },
    "@/lib/slack/fetch-thread": { fetchSlackThread: async () => [], formatThreadTranscript: () => "" },
    "@/lib/slack/classify-slack": { classifySlack: async () => intel, shouldMaterializeSlack: () => false },
    "@/lib/slack/materialize-slack": { materializeSlackIntelligence: async () => ({ auditEntries: [] }) },
    "@/lib/teams/fetch-thread": { fetchTeamsThread: async () => [], formatTeamsTranscript: () => "" },
    "@/lib/teams/classify-teams": { classifyTeams: async () => intel, shouldMaterializeSlack: () => false },
    "@/lib/teams/materialize-teams": { materializeTeamsIntelligence: async () => ({ auditEntries: [] }) },
    "@/lib/storage/persistent": { forceFlushSnapshot: async () => {} },
    "@/lib/auth": { getSessionUser: async () => "michael" },
    "@/lib/cron/identity": { resolveCronUser: async () => null },
    "@/lib/self-identity": { getSelfIdentity: async () => ({ emails: [], names: [] }) },
    "@/lib/ingest/content-hash": { hashContent: (a, b) => `${a}|${b}` },
    "@/lib/ingest/index": { isHashUnchanged: async () => false, recordIngest: async (_u, r) => { recorded.push(r.sourceRef); } },
    "@/lib/ingest/audit-log": { appendAuditEntries: async () => {} },
  });
  const res = await route.POST(new Request("https://basil.test/api/events/reprocess", { method: "POST" }));
  for (const fn of queued) await fn();
  return { res, recorded };
}
const now = new Date().toISOString();
const ROWS = [
  { id: "1", source: "slack", externalId: "slack:C1:1.2", createdAt: now, entityName: "Guy", payload: { channel: "general" } },
  { id: "2", source: "teams", externalId: "teams:chat1:m1", createdAt: now, entityName: "Ed", payload: { channel: "Ops" } },
  { id: "3", source: "slack", externalId: "teams:chat2:m2", createdAt: now, entityName: "Ed", payload: { channel: "Legacy" } },
];

test("3. a quiet thread is recorded so it is not re-classified tomorrow; Teams rows of both labels are retried", async () => {
  const { res, recorded } = await reprocess(ROWS, { category: "fyi", confidence: 0.2, actions: [], decisions: [] });
  assert.equal(res.body.queued, 3);
  assert.match(res.body.message, /1 Slack, 2 Teams/, "source:\"teams\" rows are no longer ignored");
  assert.deepEqual(plain(recorded.sort()), ["slack:C1:1.2", "teams:chat1:m1", "teams:chat2:m2"]);
});

test("3. a failed classification in the reprocess pass is still left unrecorded", async () => {
  const { recorded } = await reprocess(ROWS, { category: "low_value_noise", confidence: 0, actions: [], decisions: [], classificationFailed: true });
  assert.deepEqual(plain(recorded), []);
});

// ── 4. Day-view calendar ─────────────────────────────────────────────────────

const A = loadTs("lib/calendar/attendee-emails.ts");

test("4. 'Name <email>' yields the address; non-addresses are reported, not silently kept", () => {
  assert.equal(A.attendeeEmail("Guy Saunders <Guy@TalentGenius.io>"), "guy@talentgenius.io");
  assert.equal(A.attendeeEmail(" ed@x.io "), "ed@x.io");
  assert.equal(A.attendeeEmail("Guy Saunders"), null);
  const p = A.parseAttendees("Guy Saunders <guy@talentgenius.io>, ed@x.io, guy@talentgenius.io, Michael, ");
  assert.deepEqual(plain(p.emails), ["guy@talentgenius.io", "ed@x.io"]);
  assert.deepEqual(plain(p.bad), ["Michael"]);
  assert.deepEqual(plain(A.parseAttendees(["A <a@x.io>"]).emails), ["a@x.io"]);
});

function calendarRoutes() {
  const created = [];
  const updated = [];
  const googleCalendar = {
    createCalendarEvent: async (_u, p) => { created.push(p); return { id: "ev1", htmlLink: "https://cal/ev1" }; },
    updateCalendarEvent: async (_u, _id, p) => { updated.push(p); },
    cancelEvent: async () => ({ role: "organiser", summary: "x", told: [], noteSent: false }),
    NotAnAttendeeError: class NotAnAttendeeError extends Error {},
  };
  const googleAuth = { isGoogleConnected: async () => true };
  const mocks = {
    "next/server": nextServer,
    "@/lib/google/auth": googleAuth,
    "@/lib/google/calendar": googleCalendar,
    // The routes write through lib/calendar/writes (Google ids → Google), here over the same Google mocks.
    "@/lib/calendar/writes": loadTs("lib/calendar/writes.ts", {
      "@/lib/google/calendar": googleCalendar,
      "@/lib/google/auth": googleAuth,
      "@/lib/microsoft/auth": { isMicrosoftConnected: async () => false },
      "@/lib/microsoft/outlook-calendar": { isOutlookEventId: (id) => id.startsWith("ms:") },
    }),
    "@/lib/events/audit": { emitAuditEvent: async () => {} },
    "@/lib/auth": { getSessionUser: async () => "michael" },
    "@/lib/settings/store": { getSettings: async () => ({ timezone: "Europe/London" }) },
    "@/lib/calendar/attendee-emails": A,
  };
  return {
    create: loadTs("app/api/calendar/create/route.ts", mocks),
    byId: loadTs("app/api/calendar/[eventId]/route.ts", mocks),
    created, updated,
  };
}
const json = (body, method = "POST") => new Request("https://basil.test/api/calendar", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const ev1 = { params: Promise.resolve({ eventId: "ev1" }) };

test("4. create keeps guests picked from contacts (it used to drop every 'Name <email>')", async () => {
  const c = calendarRoutes();
  const res = await c.create.POST(json({ title: "Sync", date: "2026-11-11", startTime: "10:00", attendees: ["Guy Saunders <guy@talentgenius.io>", "ed@x.io"] }));
  assert.equal(res.status, 200);
  assert.deepEqual(plain(c.created[0].attendees), ["guy@talentgenius.io", "ed@x.io"]);
  assert.equal(res.body.attendeeCount, 2);
});

test("4. an edit sends guests' addresses; names are refused, not sent to Google; no guest field leaves guests alone", async () => {
  const c = calendarRoutes();
  const ok = await c.byId.PATCH(json({ title: "Sync", attendees: ["Guy Saunders <guy@talentgenius.io>"] }, "PATCH"), ev1);
  assert.equal(ok.status, 200);
  assert.deepEqual(plain(c.updated[0].attendees), ["guy@talentgenius.io"]);

  const names = await c.byId.PATCH(json({ title: "Sync", attendees: ["Guy Saunders"] }, "PATCH"), ev1);
  assert.equal(names.status, 400);
  assert.match(names.body.error, /Not an email address: Guy Saunders/);
  assert.equal(c.updated.length, 1, "Google was not called");

  await c.byId.PATCH(json({ startTime: "11:00", duration: 30 }, "PATCH"), ev1);
  assert.equal(c.updated[1].attendees, undefined, "a drag-move does not touch the guest list");
});

test("4. the day view pre-fills addresses, sends guests only when edited, checks res.ok, and confirms a cancel", () => {
  const d = src("app/dashboard/schedule/components/DayView.tsx");
  assert.match(d, /attendeeDetails\?: Array<\{ name: string; email: string \}>/);
  assert.match(d, /event\.attendeeDetails\s*\?\s*event\.attendeeDetails/, "edit pre-fills from addresses, not display names");
  assert.match(src("app/dashboard/schedule/page.tsx"), /attendeeDetails: e\.attendeeDetails/, "the page passes the addresses through");
  assert.match(d, /const \{ emails: attendeeList, bad \} = parseAttendees\(editState\.attendees\)/);
  assert.match(d, /\.\.\.\(guestsChanged \? \{ attendees: attendeeList \} : \{\}\)/);
  // Save, delete and drag-save all read the response before claiming success.
  assert.match(d, /if \(!res\.ok\) \{\s*setActionError\(await failureMessage\(res, editState\.eventId \? "Saving" : "Creating"\)\);\s*return;/);
  assert.match(d, /if \(!res\.ok\) \{\s*setActionError\(await failureMessage\(res, "Cancelling"\)\);\s*return;/);
  assert.match(d, /if \(!res\.ok\) setActionError\(`The move was not saved: /);
  assert.match(d, /error=\{actionError\}/);
  assert.match(d, /deleteError=\{actionError\}/);
  assert.match(d, /window\.confirm\(`Cancel "\$\{name\}"\? Everyone invited will be told it is cancelled\.`\)/);
  assert.match(d, /onDelete=\{\(\) => handleDelete\(detailEvent\.id, detailEvent\.summary\)\}/, "the bin names the meeting");
});

// ── 5. Cancel dialog ──────────────────────────────────────────────────────────

test("5. the cancel dialog clears the note, notify and error whenever it opens or changes meeting", () => {
  const c = src("components/calendar/cancel-meeting.tsx");
  assert.match(c, /const eventId = event\?\.id;\s*useEffect\(\(\) => \{\s*setNote\(""\); setNotify\(true\); setError\(null\);\s*\}, \[open, eventId\]\);/);
  // The reset is a hook, so it must sit above the early return.
  assert.ok(c.indexOf("}, [open, eventId]);") < c.indexOf("if (!event) return null;"));
});

// ── 6. One trial per person ───────────────────────────────────────────────────

function entitlements() {
  const files = new Map();
  const S = loadTs("lib/billing/entitlement-store.ts", {
    "@/lib/storage/user-store": {
      readUserStore: async (u, f, fb) => (files.has(`${u}/${f}`) ? structuredClone(files.get(`${u}/${f}`)) : fb),
      writeUserStore: async (u, f, v) => { files.set(`${u}/${f}`, structuredClone(v)); },
    },
    "@/lib/users": { isAdminUser: () => false },
    "./plans": loadTs("lib/billing/plans.ts"),
  });
  return { S, file: (u) => files.get(`${u}/entitlement.json`), put: (u, v) => files.set(`${u}/entitlement.json`, v) };
}
const expire = (rec) => ({ ...rec, trialEndsAt: "2020-01-01T00:00:00.000Z" });

test("6. once a trial has run out, checking out again does not grant another", async () => {
  const { S, file, put } = entitlements();
  const first = await S.startTrial("guy");
  assert.equal(first.status, "trialing");
  assert.equal(file("guy").trialUsed, true);
  put("guy", expire(file("guy")));
  assert.equal((await S.getEntitlement("guy")).plan, "free", "expired → Free");
  const again = await S.startTrial("guy");
  assert.equal(again.plan, "free");
  assert.equal(file("guy").trialEndsAt, "2020-01-01T00:00:00.000Z", "no new 14 days");
});

test("6. a trial record from before the flag counts, and the flag survives a paid plan and a cancel", async () => {
  const { S, file, put } = entitlements();
  put("ed", { plan: "pro", status: "trialing", trialEndsAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z" });
  assert.equal((await S.startTrial("ed")).plan, "free", "legacy expired trial: refused");

  await S.startTrial("ann");
  await S.activatePlan("ann", "pro", { provider: "stub" });
  await S.cancelPlan("ann");
  assert.equal(file("ann").trialUsed, true, "never cleared");
  assert.equal((await S.startTrial("ann")).plan, "free");
});

// ── 7. Invited colleagues get their briefing ──────────────────────────────────

function inviter({ planFails = false } = {}) {
  const plans = [];
  const I = loadTs("lib/auth/invite.ts", {
    "node:crypto": { randomBytes: (n) => Buffer.alloc(n, 1) },
    "@/lib/users": { findByEmail: async () => null, getUsers: async () => [{ username: "michael" }], createUser: async (u) => ({ ...u }) },
    "@/lib/auth/reset-tokens": { createResetToken: async () => "tok" },
    "@/lib/email/send": { sendEmail: async () => ({ ok: true }) },
    "@/lib/billing/entitlement-store": { activatePlan: async (...a) => { if (planFails) throw new Error("store down"); plans.push(a); } },
  });
  return { I, plans };
}

test("7. an invited colleague starts on Pro, so the 06:15 briefing cron includes them", async () => {
  const { I, plans } = inviter();
  const r = await I.inviteUser({ name: "Ed", email: "Ed.Baum@talentgenius.io", inviter: "Michael Cook", baseUrl: "https://basil.test" });
  assert.deepEqual(plain(plans), [["ed.baum", "pro", { provider: "stub" }]]);
  assert.equal(r.planError, undefined);
  const failing = inviter({ planFails: true });
  const r2 = await failing.I.inviteUser({ name: "Ed", email: "ed@x.io", inviter: "Michael", baseUrl: "https://basil.test" });
  assert.match(r2.link, /token=tok/, "the account and link still come back");
  assert.equal(r2.planError, "store down", "and the admin is told to set the plan");
});

function adminRoute(admin = true) {
  const calls = [];
  const route = loadTs("app/api/admin/users/[id]/route.ts", {
    "next/server": nextServer,
    "@/lib/auth": { getSessionUser: async () => (admin ? "michael" : "guy") },
    "@/lib/users": { getUsers: async () => [{ id: "u2", username: "ed.baum" }], isAdminUser: (u) => u === "michael", setUserDisabled: async () => {}, setUserAiDailyLimit: async () => {}, deleteUser: async () => {}, revokeUserSessions: async () => {} },
    "@/lib/storage/persistent": { purgeUserData: async () => ({ deleted: 0 }) },
    "@/lib/auth/siri-tokens": { revokeSiriToken: async () => {} },
    "@/lib/auth/revoke-integrations": { revokeIntegrationTokens: async () => ({ google: "none", slack: "none" }) },
    "@/lib/billing/entitlement-store": {
      activatePlan: async (...a) => { calls.push(["activate", ...a]); },
      cancelPlan: async (...a) => { calls.push(["cancel", ...a]); },
    },
  });
  const patch = (body) => route.PATCH({ json: async () => body }, { params: Promise.resolve({ id: "u2" }) });
  return { patch, calls };
}

test("7. an admin can put an existing user on Pro or Free; anything else is refused", async () => {
  const { patch, calls } = adminRoute();
  assert.equal((await patch({ action: "set-plan", plan: "pro" })).status, 200);
  assert.equal((await patch({ action: "set-plan", plan: "free" })).status, 200);
  assert.deepEqual(plain(calls), [["activate", "ed.baum", "pro", { provider: "stub" }], ["cancel", "ed.baum"]]);
  for (const plan of ["gold", undefined, "PRO"]) assert.equal((await patch({ action: "set-plan", plan })).status, 400);
  const notAdmin = adminRoute(false);
  assert.equal((await notAdmin.patch({ action: "set-plan", plan: "pro" })).status, 403);
  assert.equal(notAdmin.calls.length, 0);
});

// ── 8. Backup status and pruning ──────────────────────────────────────────────

async function backupRun(result) {
  let pruned = 0;
  const route = loadTs("app/api/cron/backup/route.ts", {
    "next/server": nextServer,
    "@/lib/storage/backup": {
      isBackupConfigured: () => true,
      backupAllUsers: async () => result,
      pruneBackups: async () => { pruned++; return { deleted: 3, complete: true }; },
    },
  }, { CRON_SECRET: "s" });
  const res = await route.GET(new Request("https://basil.test/api/cron/backup", { headers: { authorization: "Bearer s" } }));
  return { status: res.status, ok: res.body.ok, pruned };
}

test("8. the backup is a 200 only when complete with no failed copies, and only then prunes", async () => {
  assert.deepEqual(plain(await backupRun({ copied: 10, failed: 0, complete: true })), { status: 200, ok: true, pruned: 1 });
  assert.deepEqual(plain(await backupRun({ copied: 8, failed: 2, complete: true })), { status: 500, ok: false, pruned: 0 }, "failed copies used to return 200 and prune");
  assert.deepEqual(plain(await backupRun({ copied: 5, failed: 0, complete: false })), { status: 500, ok: false, pruned: 0 });
});

// ── 9. Ask Basil's profile draft ──────────────────────────────────────────────

test("9. the profile is generated for the given user directly, metered as contact-profile", async () => {
  const calls = [];
  const G = loadTs("lib/contacts/generate-profile.ts", looseMocks({
    "@/lib/ai/generate-validated": { generateValidated: async (a) => { calls.push(a); return { personality: "p", whatMakesThemTick: "t", watchOut: "w", recentActivity: "r", activitySource: "s" }; } },
    "@/lib/ai/model-config": { getTextModel: () => "model", MAX_TOKENS: { default: 4096 }, PROVIDER_MODE: "direct" },
    "@/lib/self-identity": { getSelfIdentity: async () => ({ emails: [], names: ["Guy Saunders"] }) },
    "@/lib/settings/store": { getSettings: async () => ({ toneSentiment: false }) },
    "@/lib/contacts/user-store": { listUserContacts: async () => [] },
    "@/lib/contacts/sentiment": { baselineInteractions: () => [], interactionsWith: () => [] },
    "@/lib/contacts/relationship-signals": { baselineOf: () => ({}), recentSignals: () => ({}), describeSignals: () => [] },
    "@/lib/contacts/profile-prompt": { buildProfilePrompt: () => "PROMPT", signalCount: () => 0 },
    "@/lib/ai/system-prompt": { getSystemPrompt: async () => "sys" },
    "@/lib/ai/schemas": { ContactProfileSchema: {} },
  }));
  const draft = await G.generateContactProfile("guy", { name: "Ed Baum" });
  assert.deepEqual(plain(calls[0].meter), { username: "guy", feature: "contact-profile" });
  assert.equal(calls[0].prompt, "PROMPT");
  assert.equal(draft.personality, "p");
  assert.equal(draft.signalCount, 0);
  assert.equal(draft.bodiesRead, 0);
  assert.ok(draft.generatedAt);
  await assert.rejects(G.generateContactProfile("guy", { name: " " }), /name is required/);
});

test("9. the route keeps its auth, validation and error shapes; the tool calls the function, not the route", async () => {
  class SpendCapError extends Error {}
  class AIValidationError extends Error {}
  let result = { personality: "p", signalCount: 2 };
  const route = loadTs("app/api/contacts/generate-profile/route.ts", {
    "@/lib/ai/generate-validated": { AIValidationError, aiValidationErrorResponse: () => ({ error: "invalid" }) },
    "@/lib/ai/spend-guard": { SpendCapError, spendCapResponse: () => Response.json({ error: "cap" }, { status: 429 }) },
    "@/lib/contacts/generate-profile": { generateContactProfile: async (u, b) => { if (result instanceof Error) throw result; return { ...result, by: u, for: b.name }; } },
    "@/lib/auth": { getSessionUser: async () => "michael" },
    "@/lib/privacy/rules": loadTs("lib/privacy/rules.ts"),
  });
  const post = (body) => route.POST(new Request("https://basil.test/api/contacts/generate-profile", { method: "POST", body: JSON.stringify(body) }));
  const ok = await post({ name: "Ed Baum" });
  assert.equal(ok.status, 200);
  assert.deepEqual(plain(await ok.json()), { personality: "p", signalCount: 2, by: "michael", for: "Ed Baum" });
  assert.equal((await post({ name: "" })).status, 400);
  result = new SpendCapError("cap"); assert.equal((await post({ name: "Ed" })).status, 429);
  result = new AIValidationError("bad"); assert.equal((await post({ name: "Ed" })).status, 422);
  result = new Error("boom"); assert.equal((await post({ name: "Ed" })).status, 500);

  const tools = src("lib/ai/tools.ts");
  const at = tools.indexOf("generateContactProfile: tool({");
  const block = tools.slice(at, tools.indexOf("sendSlackMessage: tool({", at));
  assert.doesNotMatch(block, /fetch\(/, "no HTTP round trip without a session");
  assert.match(block, /await import\("@\/lib\/contacts\/generate-profile"\)/);
  assert.match(block, /generateContactProfile\(username, \{ name: contactName, email, directory, notes \}\)/);
  assert.match(block, /status: "drafted"/);
});

// ── 10. Zoom return path and provider errors ──────────────────────────────────

const SR = loadTs("lib/auth/safe-return-path.ts");

test("10. only an on-site path is accepted as a return destination", () => {
  for (const ok of ["/dashboard/settings", "/onboarding?step=5", "/"]) assert.equal(SR.safeReturnPath(ok), ok);
  for (const bad of ["/\\evil.com", "//evil.com", "https://evil.com", "/dash\\x", "/\t/evil.com", "/\n/evil.com", "evil.com", "", null]) {
    assert.equal(SR.safeReturnPath(bad), null, JSON.stringify(bad));
  }
});

function redirectResponse(url) {
  const sets = [];
  return { status: 307, location: String(url), sets, cookies: { set: (n, v) => sets.push([n, v]) } };
}
const redirectServer = { NextResponse: { redirect: redirectResponse, json: nextServer.NextResponse.json }, after: () => {} };
const oauthState = { verifyOAuthState: () => true, clearOAuthStateCookie: () => ({ name: "s", value: "", options: {} }), buildOAuthState: () => ({ state: "st", name: "s", value: "v", options: {} }) };

function zoomCallback() {
  return loadTs("app/api/auth/zoom/callback/route.ts", {
    "next/server": redirectServer,
    "@/lib/zoom/auth": { exchangeZoomCode: async () => {} },
    "@/lib/auth": { getSessionUser: async () => "michael" },
    "@/lib/onboarding/backfill": { triggerOnboardingBackfill: async () => {} },
    "@/lib/storage/persistent": { forceFlushSnapshot: async () => {} },
    "@/lib/auth/oauth-state": oauthState,
    "@/lib/auth/safe-return-path": SR,
  });
}
const callbackWith = (from, query = "code=c&state=st") => zoomCallback().GET(new Request(`https://basil.test/api/auth/zoom/callback?${query}`, { headers: { cookie: `basil_zoom_from=${encodeURIComponent(from)}` } }));

test("10. the Zoom callback never redirects off-site, whatever the from cookie says", async () => {
  for (const from of ["/\\evil.com", "//evil.com"]) {
    const res = await callbackWith(from);
    const to = new URL(res.location);
    assert.equal(to.origin, "https://basil.test", `${from} → ${res.location}`);
    assert.equal(to.pathname + to.search, "/dashboard/settings?connected=zoom");
  }
  const good = new URL((await callbackWith("/dashboard/settings")).location);
  assert.equal(good.origin + good.pathname, "https://basil.test/dashboard/settings");
});

test("10. the Zoom connect start only stores an on-site return path", async () => {
  const start = loadTs("app/api/auth/zoom/route.ts", {
    "next/server": redirectServer,
    "@/lib/zoom/auth": { getZoomAuthUrl: () => "https://zoom.us/oauth/authorize?client_id=x", disconnectZoom: async () => {} },
    "@/lib/auth": { getSessionUser: async () => "michael" },
    "@/lib/storage/persistent": { forceFlushSnapshot: async () => {} },
    "@/lib/auth/oauth-state": oauthState,
    "@/lib/auth/safe-return-path": SR,
  });
  const fromCookie = async (from) => (await start.GET(new Request(`https://basil.test/api/auth/zoom?from=${encodeURIComponent(from)}`))).sets.find(([n]) => n === "basil_zoom_from")?.[1];
  assert.equal(await fromCookie("/\\evil.com"), undefined);
  assert.equal(await fromCookie("//evil.com"), undefined);
  assert.equal(await fromCookie("/dashboard/settings"), "/dashboard/settings");
});

test("10. a Zoom or Microsoft error (no code) is reported as itself, not as no_code", async () => {
  const zoom = await callbackWith("", "error=access_denied&error_description=User%20denied");
  assert.match(zoom.location, /error=zoom_oauth_failed&zoom_error=access_denied/);

  const ms = loadTs("app/api/auth/microsoft/callback/route.ts", {
    "next/server": redirectServer,
    "@/lib/microsoft/auth": { exchangeCode: async () => {} },
    "@/lib/auth": { getSessionUser: async () => "michael" },
    "@/lib/storage/persistent": { forceFlushSnapshot: async () => {} },
    "@/lib/onboarding/backfill": { triggerOnboardingBackfill: async () => {} },
    "@/lib/auth/oauth-state": oauthState,
  });
  const msGet = (q) => ms.GET(new Request(`https://basil.test/api/auth/microsoft/callback?${q}`));
  assert.match((await msGet("error=access_denied&error_description=AADSTS65001%20admin%20consent%20required")).location, /error=microsoft_admin_consent/);
  assert.match((await msGet("error=access_denied&error_description=The%20user%20cancelled")).location, /error=microsoft_access_denied/);
  assert.match((await msGet("error=server_error")).location, /error=microsoft_auth/);
  assert.match((await msGet("state=st")).location, /error=no_code/, "a bare missing code is still no_code");
});
