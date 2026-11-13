// Ingestion reliability fixes from the 2026-11-10 bug pass
// (basil-bug-pass-2026-11-10.md). Each was re-read in the code before it was
// fixed; the tests run the real modules with their boundaries mocked.
//  B6  Calendar push: changes were processed un-awaited, the sync token saved
//      anyway, and >50 changes re-read (and duplicated) forever.
//  B8  Gmail push: history read 50 records with no paging, a failed message
//      fetch was dropped, and the baseline advanced past both.
//  C7  "Seen this message?" was checked outside the lock, so two near-
//      simultaneous notifications both created the event (createEventIfNew).
//  D2  The Zoom API sync re-ran memory-only meetings every poll for 3 days.
//  D3  `void recordIngest(...)` & co. inside after()/workflow steps could be
//      cut off when the callback returned.
//  A8  Calendar "reply to organiser" hand-built its MIME: no CR/LF strip, no
//      RFC 2047, no MIME-Version.
//  B12 sendSlackMessage read 200 channels/people, took the first same-name
//      match, and re-posted as the bot on ANY failure.
//  Smaller: Slack client cache keyed by user (old token kept after a
//      disconnect), Linear integration POST/DELETE (config overwritten, webhook
//      orphaned), Linear webhook dedupe (externalId never stored), poll-ingest
//      catch-up caps, nightly backup copying uploaded media.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadTs, makeLock, nextServer } from "./_helpers/load-ts.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
// Values built inside the sandbox have its own Object/Array, so compare as plain data.
const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The REAL events store over an in-memory user store whose reads/writes take `delay` ms. */
function eventsStore({ delay = 0, log } = {}) {
  const files = new Map();
  const userStore = {
    readUserStore: async (u, f, fb) => { await sleep(delay); return files.has(`${u}/${f}`) ? structuredClone(files.get(`${u}/${f}`)) : fb; },
    writeUserStore: async (u, f, v) => { await sleep(delay); files.set(`${u}/${f}`, structuredClone(v)); log?.push(`write:${f}`); },
  };
  const store = loadTs("lib/events/store.ts", { "./lock": makeLock(), "@/lib/storage/user-store": userStore });
  return { store, userStore, files, events: (u = "michael") => files.get(`${u}/sage-events.json`) ?? [] };
}
const rules = {
  eventFromIngest: (p) => ({
    source: p.source, externalId: p.externalId, sourceRef: p.externalId, headline: p.title, context: p.body,
    payload: { title: p.title, body: p.body }, disposition: "notify", priority: "normal", status: "pending", tags: [],
  }),
};
const bus = { publish: () => {} };

// ── C7. createEventIfNew ──────────────────────────────────────────────────────

test("C7. two near-simultaneous creates for one externalId store ONE event; the loser gets the winner's event", async () => {
  const { store, events } = eventsStore({ delay: 3 });
  const e = rules.eventFromIngest({ source: "slack", externalId: "slack:C1:1.2", title: "t", body: "b" });
  const [a, b] = await Promise.all([store.createEventIfNew("michael", e), store.createEventIfNew("michael", e)]);
  assert.equal(events().length, 1);
  assert.deepEqual([a.created, b.created].sort(), [false, true]);
  assert.equal(a.event.id, b.event.id, "the duplicate is told which event already exists");
  // Legacy rows carrying only sourceRef still count as seen.
  await store.replaceAll("michael", [{ id: "old", sourceRef: "gmail:9", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", tags: [] }]);
  const legacy = await store.createEventIfNew("michael", rules.eventFromIngest({ source: "email", externalId: "gmail:9", title: "t", body: "" }));
  assert.equal(legacy.created, false);
  assert.equal(legacy.event.id, "old");
  // No external reference → cannot dedupe → always created.
  const anon = { ...e, externalId: undefined, sourceRef: undefined };
  assert.equal((await store.createEventIfNew("michael", anon)).created, true);
  assert.equal((await store.createEventIfNew("michael", anon)).created, true);
});

// Slack sends `message` AND `app_mention` for one @-mention.
function slackRoute() {
  const ev = eventsStore({ delay: 3 });
  const starts = [];
  const queued = [];
  const route = loadTs("app/api/webhooks/slack/route.ts", {
    "next/server": { NextResponse: nextServer.NextResponse, after: (t) => queued.push(t) },
    "@/lib/slack/verify": { verifySlackSignature: () => true },
    "@/lib/events/store": ev.store,
    "@/lib/events/rules": rules,
    "@/lib/events/bus": bus,
    "@/lib/slack/classify-slack": { shouldClassifySlack: () => true },
    "@/lib/webhooks/resolve-user": { resolveSlackUserByTeam: async () => "michael" },
    "@/lib/webhooks/dead-letter": { writeDeadLetter: async () => {} },
    "workflow/api": { start: async (_wf, args) => { starts.push(args[1]); } },
    "@/lib/jobs/workflows/ingest-slack": { ingestSlackWorkflow: () => {} },
    "@/lib/jobs/store": { createJobRecord: async () => {} },
    "@/lib/storage/user-store": ev.userStore,
    "@/lib/system/health": { HEALTH_META_FILE: "health-meta.json" },
  });
  return { route, ev, starts, queued };
}
const slackReq = (event) => new Request("https://basil.test/api/webhooks/slack", {
  method: "POST",
  body: JSON.stringify({ type: "event_callback", team_id: "T1", authorizations: [{ user_id: "U1", is_bot: false }], event }),
});

test("C7. Slack message + app_mention for one post: one event, one classification", async () => {
  const s = slackRoute();
  const base = { channel: "C1", channel_type: "channel", user: "U2", text: "can you look <@U1>", ts: "1.2" };
  await Promise.all([s.route.POST(slackReq({ type: "message", ...base })), s.route.POST(slackReq({ type: "app_mention", ...base }))]);
  assert.equal(s.ev.events().filter((e) => e.externalId === "slack:C1:1.2").length, 1);
  assert.equal(s.starts.length, 1, "only the delivery that created the event starts the workflow");
});

test("D3. the Slack push heartbeat is handed to after(), not left floating", async () => {
  const s = slackRoute();
  const base = { channel: "C1", channel_type: "channel", user: "U2", text: "hi", ts: "1.3" };
  await s.route.POST(slackReq({ type: "message", ...base }));
  assert.equal(s.queued.length, 1);
  assert.equal(typeof s.queued[0].then, "function", "the in-flight write is what after() keeps alive");
  await s.queued[0];
  assert.ok(s.ev.files.get("michael/health-meta.json")?.lastSlackPushAt, "heartbeat written");
  // A redelivery (dedupe early-return) inside the throttle window queues nothing new.
  await s.route.POST(slackReq({ type: "message", ...base }));
  assert.equal(s.queued.length, 1);
});

function zoomRoute() {
  const ev = eventsStore({ delay: 3 });
  const starts = [];
  const route = loadTs("app/api/webhooks/zoom/route.ts", {
    "next/server": nextServer,
    "@/lib/events/store": ev.store,
    "@/lib/events/rules": rules,
    "@/lib/events/bus": bus,
    "@/lib/webhooks/resolve-user": { resolveZoomUser: async () => "michael" },
    "@/lib/webhooks/dead-letter": { writeDeadLetter: async () => {} },
    "workflow/api": { start: async (_wf, args) => { starts.push(args[1]); } },
    "@/lib/jobs/workflows/ingest-zoom": { ingestZoomWorkflow: () => {} },
    "@/lib/jobs/store": { createJobRecord: async () => {} },
  }); // no ZOOM_WEBHOOK_SECRET_TOKEN and not production → dev path, no signature
  return { route, ev, starts };
}
const zoomReq = (event) => new Request("https://basil.test/api/webhooks/zoom", {
  method: "POST", body: JSON.stringify({ event, payload: { object: { id: 77, topic: "Weekly", host_email: "m@x.io" } } }),
});

test("C7. Zoom meeting.ended + recording.completed back to back: one event, one workflow; the transcript re-run reuses it", async () => {
  const z = zoomRoute();
  await Promise.all([z.route.POST(zoomReq("meeting.ended")), z.route.POST(zoomReq("recording.completed"))]);
  assert.equal(z.ev.events().length, 1);
  assert.equal(z.starts.length, 1);
  await z.route.POST(zoomReq("recording.transcript_completed"));
  assert.equal(z.ev.events().length, 1, "no second event");
  assert.equal(z.starts.length, 2, "the transcript still re-runs the workflow");
  assert.equal(z.starts[1].eventId, z.ev.events()[0].id, "with the existing event id — '' made the workflow create a duplicate");
});

test("C7. poll-ingest creates through createEventIfNew at every dedupe site (payloads, Zoom recaps, digest)", () => {
  const r = src("app/api/events/poll-ingest/route.ts");
  assert.doesNotMatch(r, /\bcreateEvent\(/);
  assert.equal((r.match(/await createEventIfNew\(username, /g) || []).length, 3);
  assert.equal((r.match(/if \(!created\) continue;/g) || []).length, 3, "a lost race skips the follow-up work");
  for (const f of ["app/api/webhooks/gmail/route.ts", "app/api/webhooks/slack/route.ts", "app/api/webhooks/zoom/route.ts"]) {
    assert.doesNotMatch(src(f), /\bcreateEvent\(/, f);
    assert.match(src(f), /await createEventIfNew\(webhookUsername, shaped\)/, f);
  }
});

// ── B6. Calendar push ─────────────────────────────────────────────────────────

function calendarRoute({ pages, failOn } = {}) {
  const order = [];
  const ev = eventsStore({ delay: 4, log: order });
  const listCalls = [];
  const tokens = [];
  const route = loadTs("app/api/webhooks/calendar/route.ts", {
    "next/server": nextServer,
    googleapis: { google: { calendar: () => ({ events: { list: async (q) => { listCalls.push(q); return { data: pages[q.pageToken ?? ""] }; } } }) } },
    "@/lib/google/auth": { getAuthedClient: async () => ({}) },
    "@/lib/events/store": ev.store,
    "@/lib/events/rules": { eventFromIngest: (p) => { if (failOn && p.title === failOn) throw new Error("store down"); return rules.eventFromIngest(p); } },
    "@/lib/events/bus": bus,
    "@/lib/google/watch-state": {
      getWatchState: async () => ({ calendar: { syncToken: "tok0" } }),
      updateCalendar: async (_u, patch) => { order.push(`token:${patch.syncToken}`); tokens.push(patch.syncToken); },
    },
    "@/lib/webhooks/resolve-user": { resolveCalendarChannelUser: async () => "michael" },
    "@/lib/webhooks/dead-letter": { writeDeadLetter: async () => {} },
  }, { CALENDAR_WATCH_TOKEN: "w" });
  const ping = () => route.POST(new Request("https://basil.test/api/webhooks/calendar", {
    method: "POST", headers: { "x-goog-channel-token": "w", "x-goog-resource-state": "exists", "x-goog-channel-id": "ch1" },
  }));
  return { ping, ev, listCalls, tokens, order };
}
const gev = (id, summary) => ({ id, summary, updated: "2026-11-10T09:00:00.000Z", status: "confirmed", start: { dateTime: "2026-11-11T10:00:00Z" } });
const CAL_PAGES = {
  "": { items: [gev("a", "A"), gev("b", "B")], nextPageToken: "p2" },
  p2: { items: [gev("c", "C")], nextSyncToken: "tok1" },
};

test("B6. every page is read until nextSyncToken, every change is stored, and only THEN does the token move", async () => {
  const c = calendarRoute({ pages: CAL_PAGES });
  const res = await c.ping();
  assert.equal(res.body.processed, 3);
  assert.deepEqual(plain(c.listCalls.map((q) => [q.syncToken, q.pageToken ?? null])), [["tok0", null], ["tok0", "p2"]]);
  assert.equal(c.ev.events().length, 3, "changes past the first page are not lost");
  assert.deepEqual(plain(c.tokens), ["tok1"]);
  assert.equal(c.order[c.order.length - 1], "token:tok1", "the token is saved after the last write lands, not while writes are in flight");
});

test("B6. a failure mid-way keeps the old token, and the re-read does not duplicate what was stored", async () => {
  const failing = calendarRoute({ pages: CAL_PAGES, failOn: "B" });
  await failing.ping();
  assert.deepEqual(plain(failing.tokens), [], "token not advanced past an unstored change");

  // Same store, failure gone: the redelivery re-reads A (stored) and stores B, C.
  const c = calendarRoute({ pages: CAL_PAGES });
  c.ev.files.set("michael/sage-events.json", failing.ev.events());
  const res = await c.ping();
  assert.equal(res.body.created, 2);
  assert.equal(c.ev.events().length, 3, "A is not stored twice");
  assert.deepEqual(plain(c.tokens), ["tok1"]);
  assert.match(src("app/api/webhooks/calendar/route.ts"), /if \(await handleCalendarChange\(webhookUsername, e\)\) created\+\+;/);
});

// ── B8. Gmail push ────────────────────────────────────────────────────────────

function gmailRoute({ history, getFails = {} } = {}) {
  const ev = eventsStore({ delay: 1 });
  const baselines = [];
  const starts = [];
  const listCalls = [];
  const fails = { ...getFails };
  const gmail = {
    users: {
      history: { list: async (q) => { listCalls.push(q); return { data: history(q.pageToken, listCalls.length) }; } },
      messages: {
        get: async ({ id }) => {
          if (fails[id]) { const e = new Error(`HTTP ${fails[id]}`); e.code = fails[id]; throw e; }
          return { data: { labelIds: ["INBOX"], snippet: "s", payload: { headers: [{ name: "From", value: "Ann <ann@x.io>" }, { name: "Subject", value: `About ${id}` }] } } };
        },
      },
    },
  };
  const route = loadTs("app/api/webhooks/gmail/route.ts", {
    "next/server": nextServer,
    googleapis: { google: { gmail: () => gmail } },
    "@/lib/google/auth": { getAuthedClient: async () => ({}) },
    "@/lib/events/store": ev.store,
    "@/lib/events/rules": rules,
    "@/lib/events/bus": bus,
    "@/lib/google/watch-state": { getWatchState: async () => ({ gmail: { historyId: "100" } }), updateGmail: async (_u, p) => { baselines.push(p.historyId); } },
    "@/lib/google/zoom-email-detector": { detectZoomEmail: () => ({ isZoom: false }) },
    "@/lib/email/triage": { triageEmail: () => ({ lowValue: false }) },
    "@/lib/email/known-senders": { loadKnownSenders: async () => ({ isKnown: () => true }) },
    "@/lib/google/gmail": { isBulkMail: () => false },
    "workflow/api": { start: async (_wf, args) => { starts.push(args[1].gmailId); } },
    "@/lib/jobs/workflows/ingest-gmail": { ingestGmailWorkflow: () => {} },
    "@/lib/jobs/store": { createJobRecord: async () => {} },
    "@/lib/webhooks/resolve-user": { resolveGmailUser: async () => "michael" },
    "@/lib/webhooks/dead-letter": { writeDeadLetter: async () => {} },
  }, { GMAIL_PUBSUB_TOKEN: "t" });
  const push = () => route.POST(new Request("https://basil.test/api/webhooks/gmail?token=t", {
    method: "POST",
    body: JSON.stringify({ message: { data: Buffer.from(JSON.stringify({ emailAddress: "m@x.io", historyId: "200" })).toString("base64") } }),
  }));
  return { push, ev, baselines, starts, listCalls, fails };
}
const TWO_PAGES = (token) => token === "p2"
  ? { history: [{ id: "150", messagesAdded: [{ message: { id: "m3" } }] }] }
  : { history: [{ id: "101", messagesAdded: [{ message: { id: "m1" } }, { message: { id: "m2" } }] }], nextPageToken: "p2" };

test("B8. the whole history delta is paged; the baseline moves only after every message is in", async () => {
  const g = gmailRoute({ history: TWO_PAGES });
  const res = await g.push();
  assert.equal(res.status, 200);
  assert.equal(g.listCalls.length, 2);
  assert.equal(g.listCalls[1].pageToken, "p2");
  assert.deepEqual(plain(g.starts.sort()), ["m1", "m2", "m3"], "the message on page 2 is not skipped");
  assert.deepEqual(plain(g.baselines), ["200"]);
});

test("B8. one failed message fetch keeps the baseline and returns 503; the Pub/Sub retry ingests it without duplicates", async () => {
  const g = gmailRoute({ history: TWO_PAGES, getFails: { m2: 500 } });
  const res = await g.push();
  assert.equal(res.status, 503);
  assert.deepEqual(plain(g.baselines), [], "not advanced past the failed message");
  delete g.fails.m2;
  const retry = await g.push();
  assert.equal(retry.status, 200);
  assert.deepEqual(plain(g.starts.sort()), ["m1", "m2", "m3"], "each message classified exactly once across both deliveries");
  assert.equal(g.ev.events().length, 3);
  assert.deepEqual(plain(g.baselines), ["200"]);
});

test("B8. a message deleted before we fetched it (404) is not a failure; a page cap advances only as far as was read", async () => {
  const gone = gmailRoute({ history: TWO_PAGES, getFails: { m2: 404 } });
  assert.equal((await gone.push()).status, 200);
  assert.deepEqual(plain(gone.baselines), ["200"]);

  const endless = gmailRoute({ history: (_t, n) => ({ history: [{ id: String(100 + n), messagesAdded: [] }], nextPageToken: "more" }) });
  const res = await endless.push();
  assert.equal(endless.listCalls.length, 20);
  assert.equal(res.body.partial, true);
  assert.deepEqual(plain(endless.baselines), ["120"], "resume from the last record read, not the notification's id");
});

// ── D2. Zoom API sync ─────────────────────────────────────────────────────────

function meetingProcessor(generateTextSafe, parse) {
  return loadTs("lib/zoom/process-meeting.ts", {
    "@/lib/ai/generate": { generateTextSafe },
    "@/lib/ai/model-config": { getTextModel: () => "m", MAX_TOKENS: { fast: 1024 } },
    "@/lib/ai/parse-json": { parseAndValidate: parse },
    "@/lib/ai/schemas": { MeetingIntelligenceSchema: {} },
    "@/lib/ai/system-prompt": { getTaskSystemPrompt: async () => "" },
    "@/lib/actions/store": { createAction: async () => ({ id: "a" }) },
    "@/lib/decisions/store": { createDecision: async () => ({ id: "d" }) },
    "@/lib/contacts/tone-store": { writeToneObservations: async () => {} },
    "@/lib/memory/store": { createMemory: async () => ({ id: "m" }) },
    "@/lib/trust/policy": { actionTier: () => "auto", decisionTier: () => "auto", memoryTier: () => "auto", needsReviewFlag: () => false },
    "@/lib/contacts/touch-recency": { touchContactsRecency: async () => 0 },
    "@/lib/contacts/user-store": { listUserContacts: async () => [] },
    "@/lib/self-identity": { getSelfIdentity: async () => ({ emails: [], names: [] }), normaliseOwner: (o) => o, selfInContext: (i) => i },
  });
}
const MEETING = { id: "9", uuid: "x", topic: "AG weekly", startTime: "2026-11-09T14:00:00Z", duration: 45, hostId: "h", type: 2 };
const TRANSCRIPT = { meetingId: "9", transcript: "Ann: we agreed the plan. ".repeat(10) };

test("D2. a failed meeting extraction says so; a summary-only success does not", async () => {
  const failed = await meetingProcessor(async () => { throw new Error("provider down"); }, () => ({ ok: false }))
    .processZoomMeeting({ username: "u", meeting: MEETING, participants: [], recording: TRANSCRIPT });
  assert.equal(failed.extractionFailed, true);
  const ok = await meetingProcessor(async () => ({ text: "{}" }), () => ({ ok: true, data: { actions: [], decisions: [], summary: "Talked.", keyTopics: [], toneShifts: [] } }))
    .processZoomMeeting({ username: "u", meeting: MEETING, participants: [], recording: TRANSCRIPT });
  assert.equal(ok.extractionFailed, undefined);
  assert.equal(ok.actionsCreated + ok.decisionsCreated, 0, "only memories — the case that was re-run every poll");
});

test("D2. the Zoom API sync marks each processed meeting with what it saw, and skips it until a transcript changes that", () => {
  const r = src("app/api/events/poll-ingest/route.ts");
  const at = r.indexOf("// ── Zoom direct API meeting sync");
  const block = r.slice(at, r.indexOf("// ── Write health metadata", at));
  assert.match(block, /const zoomHash = hashContent\(sourceRef, transcript\.length > 100 \? transcript : ""\);/);
  assert.match(block, /if \(await isHashUnchanged\(username, sourceRef, zoomHash\)\) continue;/);
  assert.match(block, /if \(!result\.extractionFailed\) await recordIngest\(username, \{ sourceRef, hash: zoomHash \}\);/);
  assert.ok(block.indexOf("isHashUnchanged") < block.indexOf("await processZoomMeeting("), "checked before the model call");
});

// ── D3. Awaited markers ───────────────────────────────────────────────────────

const slowRecorder = () => {
  const recorded = [];
  return { recorded, recordIngest: async (_u, r) => { await sleep(15); recorded.push(r); } };
};
function slackIngestMocks(rec) {
  const intel = { category: "fyi", confidence: 0.3, actions: [], decisions: [] };
  return {
    workflow: { FatalError: class FatalError extends Error {} },
    "./store": { updateJobRecord: async () => {} },
    "@/lib/ingest/content-hash": { hashContent: () => "hash-1" },
    "@/lib/ingest/index": { isHashUnchanged: async () => false, recordIngest: rec.recordIngest },
    "@/lib/ingest/audit-log": { appendAuditEntries: async () => {}, auditSkipped: () => ({}) },
    "@/lib/self-identity": { getSelfIdentity: async () => ({ emails: [], names: [] }) },
    "@/lib/slack/fetch-thread": { fetchSlackThread: async () => [], formatThreadTranscript: () => "" },
    "@/lib/slack/classify-slack": { classifySlack: async () => intel, shouldMaterializeSlack: () => false },
    "@/lib/slack/materialize-slack": { materializeSlackIntelligence: async () => ({ auditEntries: [] }) },
  };
}
const SLACK_JOB = { channelId: "C1", messageTs: "1.2", externalId: "slack:C1:1.2", eventId: "e1", channelName: "general", from: "Guy", date: "2026-11-10T09:00:00Z", isDM: false, isMention: false, bodyFallback: "hi" };

test("D3. the Slack workflow step and job executor finish their ingest marker before returning", async () => {
  const wf = slowRecorder();
  await loadTs("lib/jobs/workflows/ingest-slack.ts", slackIngestMocks(wf)).ingestSlackWorkflow("michael", SLACK_JOB);
  assert.equal(wf.recorded.length, 1, "a step that returns with the write still pending can lose it");
  const ex = slowRecorder();
  await loadTs("lib/jobs/executor.ts", slackIngestMocks(ex)).executeJob("ingest.slack", "michael", SLACK_JOB, "job1");
  assert.equal(ex.recorded.length, 1);
});

test("D3. the reprocess after() callback holds until the marker is written", async () => {
  const rec = slowRecorder();
  const queued = [];
  const route = loadTs("app/api/events/reprocess/route.ts", {
    "next/server": { NextResponse: nextServer.NextResponse, after: (fn) => queued.push(fn) },
    "@/lib/events/store": { listEvents: async () => [{ id: "1", source: "slack", externalId: "slack:C1:1.2", createdAt: new Date().toISOString(), entityName: "Guy", payload: { channel: "general" } }] },
    "@/lib/actions/store": { listActions: async () => [] },
    "@/lib/decisions/store": { listDecisions: async () => [] },
    "@/lib/email/process-gmail-message": { processRegularEmail: async () => {}, processZoomEmail: async () => {} },
    "@/lib/microsoft/outlook-mail": { getOutlookMessageBody: async () => "" },
    "@/lib/slack/fetch-thread": { fetchSlackThread: async () => [], formatThreadTranscript: () => "" },
    "@/lib/slack/classify-slack": { classifySlack: async () => ({ category: "fyi", confidence: 0.2, actions: [], decisions: [] }), shouldMaterializeSlack: () => false },
    "@/lib/slack/materialize-slack": { materializeSlackIntelligence: async () => ({ auditEntries: [] }) },
    "@/lib/teams/fetch-thread": { fetchTeamsThread: async () => [], formatTeamsTranscript: () => "" },
    "@/lib/teams/classify-teams": { classifyTeams: async () => ({}), shouldMaterializeSlack: () => false },
    "@/lib/teams/materialize-teams": { materializeTeamsIntelligence: async () => ({ auditEntries: [] }) },
    "@/lib/storage/persistent": { forceFlushSnapshot: async () => {} },
    "@/lib/auth": { getSessionUser: async () => "michael" },
    "@/lib/cron/identity": { resolveCronUser: async () => null },
    "@/lib/self-identity": { getSelfIdentity: async () => ({ emails: [], names: [] }) },
    "@/lib/ingest/content-hash": { hashContent: (a, b) => `${a}|${b}` },
    "@/lib/ingest/index": { isHashUnchanged: async () => false, recordIngest: rec.recordIngest },
    "@/lib/ingest/audit-log": { appendAuditEntries: async () => {} },
  });
  await route.POST(new Request("https://basil.test/api/events/reprocess", { method: "POST" }));
  for (const fn of queued) await fn();
  assert.equal(rec.recorded.length, 1);
});

test("D3. processZoomEmail returns only once its ingest marker is stored", async () => {
  const rec = slowRecorder();
  const loose = (exports = {}) => new Proxy(exports, { get: (t, k) => (k in t ? t[k] : k === "__esModule" ? undefined : async () => ({})) });
  const mocks = new Proxy({
    "@/lib/zoom/extract-meeting": { extractZoomMeeting: async () => ({ meetingTitle: "W", meetingDate: "2026-11-10", attendees: [], summary: "", actionItems: [], decisions: [], blockers: [], followUps: [], topics: [], toneShifts: [], confidence: 0 }) },
    "@/lib/ingest/index": loose({ isHashUnchanged: async () => false, recordIngest: rec.recordIngest }),
    "@/lib/ingest/content-hash": loose({ hashContent: () => "zoom-hash" }),
    "@/lib/self-identity": loose({ getSelfIdentity: async () => ({ emails: [], names: ["Michael"] }), selfInContext: () => ({ emails: [], names: ["Michael"] }) }),
    "@/lib/contacts/user-store": loose({ listUserContacts: async () => [] }),
    "@/lib/trust/policy": loose({ ZOOM_REVIEW_FLOOR: 0.4 }),
    "@/lib/ingest/audit-log": loose({ appendAuditEntries: async () => {}, auditFailed: () => ({}), auditSkipped: () => ({}) }),
  }, {
    getOwnPropertyDescriptor: (t, k) => Object.getOwnPropertyDescriptor(t, k) ?? { value: loose(), configurable: true, enumerable: true, writable: true },
    get: (t, k) => (k in t ? t[k] : loose()),
  });
  const P = loadTs("lib/email/process-gmail-message.ts", mocks);
  await P.processZoomEmail({ username: "michael", gmailId: "", externalId: "gmail:z1", eventId: "e1", subject: "W", dateFallback: "2026-11-10", body: "Notes from the call" });
  assert.equal(rec.recorded.length, 1);
});

test("D3. no fire-and-forget marker, audit or back-link write is left in the ingest paths; post-response work goes through after()", () => {
  for (const f of [
    "lib/email/process-gmail-message.ts", "app/api/events/poll-ingest/route.ts", "app/api/events/reprocess/route.ts",
    "lib/jobs/workflows/ingest-slack.ts", "lib/jobs/executor.ts",
  ]) {
    assert.doesNotMatch(src(f), /void (recordIngest|appendAuditEntries|updateEvent)\(/, f);
  }
  assert.match(src("app/api/webhooks/slack/route.ts"), /const stamp = stampSlackPushHeartbeat\(webhookUsername\);\s*if \(stamp\) after\(stamp\);/);
  assert.match(src("app/api/webhooks/linear/route.ts"), /after\(async \(\) => \{\s*try \{\s*await syncLinearActionStates\(ownerName, \{ force: true \}\);/);
});

// ── A8. Calendar reply MIME ───────────────────────────────────────────────────

function calendarReply(summary) {
  const sent = [];
  const gmail = loadTs("lib/google/gmail.ts", {
    googleapis: { google: { gmail: () => ({ users: { messages: { send: async ({ requestBody }) => { sent.push(requestBody.raw); return { data: { id: "s1" } }; } } } }) } },
    "./auth": { getAuthedClient: async () => ({}) },
    "@/lib/self-identity": { getSelfIdentity: async () => ({ emails: [], names: [] }) },
  });
  const route = loadTs("app/api/calendar/[eventId]/reply/route.ts", {
    "next/server": nextServer,
    "@/lib/google/auth": { isGoogleConnected: async () => true, getAuthedClient: async () => ({}) },
    "@/lib/auth": { getSessionUser: async () => "michael" },
    googleapis: { google: { calendar: () => ({ events: { get: async () => ({ data: {
      summary, organizer: { email: "org@x.io" },
      attendees: [{ email: "org@x.io" }, { email: "ann@x.io" }, { email: "me@x.io", self: true }],
    } }) } }) } },
    "@/lib/events/audit": { emitAuditEvent: async () => {} },
    "@/lib/google/gmail": gmail,
  });
  const send = async () => {
    const res = await route.POST(
      new Request("https://basil.test/api/calendar/ev1/reply", { method: "POST", body: JSON.stringify({ message: "Running late", replyAll: true }) }),
      { params: Promise.resolve({ eventId: "ev1" }) },
    );
    const mime = Buffer.from(sent[0], "base64url").toString("utf8");
    const [head, body] = mime.split("\r\n\r\n");
    return { res, headers: head.split("\r\n"), body };
  };
  return { send };
}

test("A8. a newline in the invite title cannot add a header; a non-ASCII subject is RFC 2047-encoded; MIME-Version is set", async () => {
  const { res, headers, body } = await calendarReply("Café sync\r\nBcc: evil@x.io").send();
  assert.equal(res.status, 200);
  assert.ok(!headers.some((h) => /^bcc:/i.test(h)), `injected header present: ${headers.join(" | ")}`);
  assert.ok(headers.includes(`Subject: =?UTF-8?B?${Buffer.from("Re: Café sync Bcc: evil@x.io", "utf8").toString("base64")}?=`));
  assert.ok(headers.includes("MIME-Version: 1.0"));
  assert.ok(headers.includes("To: org@x.io, ann@x.io"), "organiser plus the other guests, never you");
  assert.equal(body, "Running late");

  const ascii = await calendarReply("Sync\nBcc: evil@x.io").send();
  assert.ok(ascii.headers.includes("Subject: Re: Sync Bcc: evil@x.io"));
  assert.ok(!ascii.headers.some((h) => /^bcc:/i.test(h)));
});

// ── B12. sendSlackMessage ─────────────────────────────────────────────────────

function slackWorkspace({ userPostError } = {}) {
  const posts = [];
  const channels = Array.from({ length: 450 }, (_, i) => ({ id: `C${i}`, name: `chan-${i}` }));
  const members = [
    ...Array.from({ length: 250 }, (_, i) => ({ id: `U${i}`, name: `user${i}`, real_name: `User ${i}` })),
    { id: "UG1", name: "guy.s", real_name: "Guy Saunders" },
    { id: "UG2", name: "gsaunders", real_name: "Guy Saunders" },
    { id: "UOLD", name: "edbaum", real_name: "Ed Baum", deleted: true },
    { id: "UED", name: "ed", real_name: "Ed Baum" },
  ];
  const page = (arr, cursor, limit) => { const s = cursor ? Number(cursor) : 0; return { items: arr.slice(s, s + limit), next: s + limit < arr.length ? String(s + limit) : "" }; };
  const make = (who) => ({
    conversations: {
      list: async ({ cursor, limit }) => { const p = page(channels, cursor, limit); return { channels: p.items, response_metadata: { next_cursor: p.next } }; },
      open: async ({ users }) => ({ channel: { id: `D-${users}` } }),
    },
    users: { list: async ({ cursor, limit }) => { const p = page(members, cursor, limit); return { members: p.items, response_metadata: { next_cursor: p.next } }; } },
    chat: {
      postMessage: async ({ channel }) => {
        if (who === "user" && userPostError) { const e = new Error(`An API error occurred: ${userPostError}`); e.data = { ok: false, error: userPostError }; throw e; }
        posts.push(`${who}:${channel}`);
        return { ok: true };
      },
    },
  });
  const clients = { "xoxb-test": make("bot"), "xoxp-test": make("user") };
  class WebClient { constructor(token) { return clients[token]; } }
  const client = loadTs("lib/slack/client.ts", {
    "@slack/web-api": { WebClient, LogLevel: {} },
    "@/lib/storage/secure-token-store": { getIntegrationToken: async () => null, saveIntegrationToken: async () => {}, deleteIntegrationToken: async () => {} },
    "@/lib/slack/render": { renderSlackText: (t) => t },
    "@/lib/auth/env-credential-owner": { isEnvCredentialOwner: () => true },
  }, { SLACK_BOT_TOKEN: "xoxb-test", SLACK_USER_TOKEN: "xoxp-test" });
  return { send: (to) => client.sendSlackMessage("michael", to, "hello"), posts };
}

test("B12. channels and people past the first 200 are found, and a post goes out as you", async () => {
  const w = slackWorkspace();
  assert.deepEqual(plain(await w.send("#chan-420")), { ok: true });
  assert.deepEqual(plain(await w.send("User 240")), { ok: true });
  assert.deepEqual(plain(w.posts), ["user:C420", "user:D-U240"]);
});

test("B12. two people with the same name: an error naming both, nothing sent; @handle picks one; deactivated accounts don't count", async () => {
  const w = slackWorkspace();
  const r = await w.send("Guy Saunders");
  assert.equal(r.ok, false);
  assert.match(r.error, /matches 2 people/);
  assert.match(r.error, /@guy\.s/);
  assert.match(r.error, /@gsaunders/);
  assert.equal(w.posts.length, 0);
  assert.equal((await w.send("@gsaunders")).ok, true);
  assert.equal((await w.send("Ed Baum")).ok, true, "the deactivated Ed Baum is not a second candidate");
  assert.deepEqual(plain(w.posts), ["user:D-UG2", "user:D-UED"]);
});

test("B12. the bot re-posts only for not_in_channel; any other failure is returned, not re-sent under the bot's name", async () => {
  const notIn = slackWorkspace({ userPostError: "not_in_channel" });
  assert.equal((await notIn.send("#chan-3")).ok, true);
  assert.deepEqual(plain(notIn.posts), ["bot:C3"]);
  const other = slackWorkspace({ userPostError: "msg_too_long" });
  const r = await other.send("#chan-3");
  assert.equal(r.ok, false);
  assert.match(r.error, /msg_too_long/);
  assert.deepEqual(plain(other.posts), []);
});

// ── Slack client cache ────────────────────────────────────────────────────────

test("Slack clients follow the stored token: a reconnect or disconnect elsewhere is picked up within 30 s", async () => {
  let now = Date.parse("2026-11-10T09:00:00Z");
  class FakeDate extends Date { static now() { return now; } }
  let stored = { botToken: "xoxb-A", userToken: "xoxp-A" };
  let reads = 0;
  class WebClient { constructor(token) { this.token = token; } }
  const client = loadTs("lib/slack/client.ts", {
    "@slack/web-api": { WebClient, LogLevel: {} },
    "@/lib/storage/secure-token-store": {
      getIntegrationToken: async () => { reads++; return stored; },
      saveIntegrationToken: async (_u, _p, v) => { stored = v; },
      deleteIntegrationToken: async () => { stored = null; },
    },
    "@/lib/slack/render": { renderSlackText: (t) => t },
    "@/lib/auth/env-credential-owner": { isEnvCredentialOwner: () => false },
  }, {}, { Date: FakeDate });

  const first = await client.getSlackUserClientForUser("guy");
  assert.equal(first.token, "xoxp-A");
  assert.equal(await client.getSlackUserClientForUser("guy"), first, "one client per token, not one per call");
  assert.equal((await client.getSlackBotClientForUser("guy")).token, "xoxb-A");
  assert.equal(reads, 1, "concurrent and repeated lookups share one config read");

  stored = { botToken: "xoxb-B", userToken: "xoxp-B" }; // reconnected on another instance
  now += 31_000;
  assert.equal((await client.getSlackUserClientForUser("guy")).token, "xoxp-B", "the old username-keyed cache kept xoxp-A forever");

  stored = null; // disconnected on another instance (or a storage read that came back empty)
  now += 31_000;
  assert.equal(await client.getSlackUserClientForUser("guy"), null);
  assert.equal(await client.getSlackBotClientForUser("guy"), null);
  stored = { userToken: "xoxp-D" };
  assert.equal((await client.getSlackUserClientForUser("guy")).token, "xoxp-D", "an empty read is not cached as 'disconnected'");

  await client.saveSlackConfig("guy", { userToken: "xoxp-C" }); // on THIS instance: immediate
  assert.equal((await client.getSlackUserClientForUser("guy")).token, "xoxp-C");
});

// ── C8. Linear integration route ──────────────────────────────────────────────

function linearIntegration(initial) {
  let cfg = { ...initial };
  const calls = [];
  let registerFails = false;
  const route = loadTs("app/api/integrations/linear/route.ts", {
    "next/server": nextServer,
    "@/lib/auth": { verifySession: async () => true, getSessionUser: async () => "michael" },
    "@/lib/linear/client": {
      getLinearConfig: async () => ({ ...cfg }),
      saveLinearConfig: async (_u, c) => { calls.push(["save"]); cfg = { ...c }; },
      deleteLinearConfig: async () => { calls.push(["delete"]); cfg = {}; },
      validateAndIntrospect: async (key) => ({ name: "Michael", organizationId: key.startsWith("other") ? "org2" : "org1" }),
      registerLinearWebhook: async (_u, url) => { if (registerFails) throw new Error("localhost"); calls.push(["register", url, cfg.apiKey]); return { id: "wh-new", secret: "sec-new" }; },
      unregisterLinearWebhook: async (_u, id) => { calls.push(["unregister", id, cfg.apiKey]); },
    },
  }, { BASIL_PUBLIC_URL: "https://basil.test" });
  const post = (apiKey) => route.POST(new Request("https://basil.test/api/integrations/linear", { method: "POST", body: JSON.stringify({ apiKey }) }));
  return { route, post, calls, cfg: () => cfg, failRegister: () => { registerFails = true; } };
}
const CONNECTED = { apiKey: "old-key", organizationId: "org1", webhookId: "wh1", webhookSecret: "s1" };

test("C8. a new key for the same workspace keeps the org id and the push webhook", async () => {
  const l = linearIntegration(CONNECTED);
  const res = await l.post("new-key");
  assert.equal(res.status, 200);
  assert.equal(res.body.webhookRegistered, true);
  assert.deepEqual(plain(l.cfg()), { apiKey: "new-key", organizationId: "org1", webhookId: "wh1", webhookSecret: "s1" });
  assert.ok(!l.calls.some(([c]) => c === "register" || c === "unregister"));
});

test("C8. a key for another workspace retires the old webhook (with the old key) and registers a new one", async () => {
  const l = linearIntegration(CONNECTED);
  await l.post("other-key");
  assert.deepEqual(plain(l.calls.filter(([c]) => c !== "save")), [
    ["unregister", "wh1", "old-key"],
    ["register", "https://basil.test/api/webhooks/linear", "other-key"],
  ]);
  assert.deepEqual(plain(l.cfg()), { apiKey: "other-key", organizationId: "org2", webhookId: "wh-new", webhookSecret: "sec-new" });
});

test("C8. a first connection captures the org id; a webhook failure does not block connecting", async () => {
  const l = linearIntegration({});
  l.failRegister();
  const res = await l.post("new-key");
  assert.equal(res.status, 200);
  assert.equal(res.body.webhookRegistered, false);
  assert.deepEqual(plain(l.cfg()), { apiKey: "new-key", organizationId: "org1" });
});

test("C8. disconnecting unregisters the webhook at Linear before the credentials go", async () => {
  const l = linearIntegration(CONNECTED);
  const res = await l.route.DELETE();
  assert.equal(res.status, 200);
  assert.deepEqual(plain(l.calls), [["unregister", "wh1", "old-key"], ["delete"]]);
});

// ── Linear webhook dedupe ─────────────────────────────────────────────────────

function linearWebhook() {
  const ev = eventsStore({ delay: 2 });
  const audit = loadTs("lib/events/audit.ts", { "./store": ev.store, "./bus": bus });
  const queued = [];
  let syncs = 0;
  const route = loadTs("app/api/webhooks/linear/route.ts", {
    "next/server": { NextResponse: nextServer.NextResponse, after: (fn) => queued.push(fn) },
    "@/lib/users": { getUsers: async () => [{ username: "michael" }] },
    "@/lib/linear/client": { getLinearConfig: async () => ({ organizationId: "org1", webhookSecret: "sec" }) },
    "@/lib/events/store": ev.store,
    "@/lib/events/audit": audit,
    "@/lib/linear/sync-actions": { syncLinearActionStates: async () => { syncs++; return { closed: 0 }; } },
  });
  const deliver = (body, headers = {}) => {
    const raw = JSON.stringify({ organizationId: "org1", type: "Issue", action: "update", data: { id: "i1", identifier: "ENG-1", title: "Fix" }, ...body });
    const sig = crypto.createHmac("sha256", "sec").update(raw).digest("hex");
    return route.POST(new Request("https://basil.test/api/webhooks/linear", { method: "POST", headers: { "linear-signature": sig, ...headers }, body: raw }));
  };
  return { deliver, ev, queued, syncs: () => syncs };
}

test("Linear: a repeat delivery is recognised (the record now carries its externalId), even when two arrive together", async () => {
  const w = linearWebhook();
  await Promise.all([w.deliver({}, { "linear-delivery": "d1" }), w.deliver({}, { "linear-delivery": "d1" })]);
  const again = await w.deliver({}, { "linear-delivery": "d1" });
  assert.equal(again.body.skipped, "duplicate delivery");
  assert.deepEqual(plain(w.ev.events().map((e) => e.externalId)), ["linear:delivery:d1"]);
});

test("Linear: without a delivery id, two different updates to one issue are NOT merged into one", async () => {
  const w = linearWebhook();
  await w.deliver({ createdAt: "2026-11-10T09:00:00Z", data: { id: "i1", updatedAt: "2026-11-10T09:00:00Z" } });
  await w.deliver({ createdAt: "2026-11-10T10:00:00Z", data: { id: "i1", updatedAt: "2026-11-10T10:00:00Z" } });
  assert.equal(w.ev.events().length, 2);
  const dup = await w.deliver({ createdAt: "2026-11-10T10:00:00Z", data: { id: "i1", updatedAt: "2026-11-10T10:00:00Z" } });
  assert.equal(dup.body.skipped, "duplicate delivery", "the same event redelivered is still a repeat");
});

test("Linear: the issue state-sync runs inside after(), so it is not cut off with the response", async () => {
  const w = linearWebhook();
  await w.deliver({}, { "linear-delivery": "d2" });
  assert.equal(w.syncs(), 0, "not started as a floating promise");
  for (const fn of w.queued) await fn();
  assert.equal(w.syncs(), 1);
});

// ── poll-ingest catch-up caps ─────────────────────────────────────────────────

test("poll-ingest reads 60 emails and 100 Slack messages in the same windows, behind the same dedupe", () => {
  const r = src("app/api/events/poll-ingest/route.ts");
  assert.match(r, /track\("email", getRecentEmails\(username, 60\)\)/);
  assert.match(r, /track\("slack", getRecentSlackMessages\(username, 100\)\)/);
  // Windows unchanged: getRecentEmails defaults to 2 days, getRecentSlackMessages to 7.
  assert.match(src("lib/google/gmail.ts"), /maxResults = 10,\s*maxAgeDays = 2\s*\)/);
  assert.match(src("lib/slack/client.ts"), /limit      = 10,\s*maxAgeDays = 7\s*\)/);
  // Already-seen items stop before any event or classification.
  assert.match(r, /if \(p\.externalId && \(await hasExternalId\(username, p\.externalId\)\)\) continue;\s*const shaped = eventFromIngest\(p\);\s*const \{ created, event \} = await createEventIfNew\(username, shaped\);\s*if \(!created\) continue;/);
});

// ── Backup excludes uploaded media ────────────────────────────────────────────

test("the nightly backup never lists or copies basil/media/ (uploaded originals)", async () => {
  const B = loadTs("lib/storage/backup.ts", { "@vercel/blob": {} });
  const paths = ["basil/secure-users.json", "basil/users/michael/sage-actions.json", "basil/media/michael/call.m4a", "basil/media/michael/deck.pdf", "basil/counters/x.json"];
  const listed = [];
  const copied = [];
  const api = {
    list: async ({ prefix, mode }) => {
      listed.push(prefix);
      const under = paths.filter((p) => p.startsWith(prefix)).map((p) => ({ pathname: p, url: `https://blob.invalid/${p}`, uploadedAt: new Date() }));
      if (mode === "folded") {
        const folders = new Set(), blobs = [];
        for (const b of under) { const rest = b.pathname.slice(prefix.length); if (rest.includes("/")) folders.add(prefix + rest.split("/")[0] + "/"); else blobs.push(b); }
        return { blobs, folders: [...folders], hasMore: false };
      }
      return { blobs: under, hasMore: false };
    },
    copy: async (_url, to) => { copied.push(to.replace("basil/_backups/2026-11-10/", "")); },
    del: async () => {},
  };
  const r = await B.backupAllUsers("2026-11-10", { api });
  assert.equal(r.complete, true);
  assert.ok(!listed.some((p) => p.startsWith("basil/media/")), "media is not even paged through");
  assert.deepEqual(plain(copied.sort()), ["counters/x.json", "secure-users.json", "users/michael/sage-actions.json"]);
});
