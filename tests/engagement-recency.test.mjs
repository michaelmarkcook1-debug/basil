/**
 * 2026-10-08: people Michael talks to on Slack and sees on Zoom group calls
 * were listed as "gone quiet". The stored last-contact date missed:
 *  - his OWN Slack messages (dropped before any touch was recorded),
 *  - calendar attendees whose display name differs from the contact's name
 *    (the email was thrown away),
 *  - every meeting fetched from the Zoom API (never touched recency),
 * and a single "warming" tone note counted as a relationship risk.
 * Real modules; Google, Slack, Zoom and storage mocked. Synthetic people only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadTs } from "./_helpers/load-ts.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

// ── Matching by email ─────────────────────────────────────────────────────────

function recency(contacts) {
  const updates = [];
  const mod = loadTs("lib/contacts/touch-recency.ts", {
    "@/lib/contacts/user-store": {
      listUserContacts: async () => structuredClone(contacts),
      updateUserContactInStore: async (_u, id, patch) => { updates.push({ id, ...patch }); return {}; },
    },
  });
  return { touch: (t) => mod.touchContactsRecency("u", t), updates };
}

test("a calendar attendee shown as 'Matt P.' matches Matthew Paquette by email", async () => {
  const r = recency([{ id: "c1", name: "Matthew Paquette", email: "matthew@partner.invalid", lastInteraction: "2026-09-01T10:00:00Z" }]);
  await r.touch([{ name: "Matt P.", email: "matthew@partner.invalid", date: "2026-10-06T15:00:00Z", source: "calendar" }]);
  assert.equal(JSON.stringify(r.updates), JSON.stringify([{ id: "c1", lastInteraction: "2026-10-06T15:00:00Z", activitySource: "calendar" }]));
});

test("the calendar keeps each attendee's email — not you, not rooms, not people who declined", async () => {
  const items = [{
    id: "e1", summary: "AG weekly", start: { dateTime: "2026-10-06T14:00:00Z" }, end: { dateTime: "2026-10-06T15:00:00Z" },
    organizer: { email: "ed@partner.invalid", displayName: "Ed Baum" },
    attendees: [
      { email: "me@fixture.invalid", self: true, responseStatus: "accepted" },
      { email: "Matthew@Partner.invalid", displayName: "Matt P.", responseStatus: "accepted" },
      { email: "room-4@resource.calendar.google.com", displayName: "Room 4", resource: true },
      { email: "isaac@partner.invalid", displayName: "Isaac", responseStatus: "declined" },
      { email: "priya@partner.invalid", responseStatus: "needsAction" },
    ],
  }];
  const cal = { events: { list: async () => ({ data: { items } }) } };
  const C = loadTs("lib/google/calendar.ts", {
    googleapis: { google: { calendar: () => cal } },
    "./auth": { getAuthedClient: async () => ({}) },
    "./gmail": {},
    "@/lib/self-identity": { getSelfIdentity: async () => ({ emails: ["me@fixture.invalid"], names: [] }), stripSelf: (a) => a },
  });
  const [ev] = await C.getEventsForMonth("u", 2026, 9);
  assert.equal(JSON.stringify(ev.attendeeDetails), JSON.stringify([
    { name: "Matt P.", email: "matthew@partner.invalid" },
    { name: "", email: "priya@partner.invalid" },
  ]));
  assert.match(src("app/api/events/poll-ingest/route.ts"), /ev\.attendeeDetails\?\.length/);
  assert.match(src("app/api/events/poll-ingest/route.ts"), /const lookbackMs = 14 \* 24 \* 3_600_000;/, "last week's group call still counts");
});

// ── Slack: your own messages ─────────────────────────────────────────────────

test("your own Slack DM / group-DM messages count as contact with the others in it", () => {
  const s = src("app/api/events/poll-ingest/route.ts");
  const loop = s.slice(s.indexOf("  for (const m of slacks) {"), s.indexOf("const isDM = m.channel.startsWith"));
  const selfBranch = loop.slice(loop.indexOf("if (isSelf(m.author, selfIdentity)) {"), loop.indexOf("continue;", loop.indexOf("if (isSelf(m.author, selfIdentity)) {")));
  assert.match(selfBranch, /for \(const member of m\.channelMembers \?\? \[\]\)[\s\S]*slackRecencyTouches\.push/,
    "self messages record touches for the DM's members before skipping ingestion");
  assert.doesNotMatch(loop, /if \(isSelf\(m\.author, selfIdentity\)\) continue;/, "the old early drop is gone");
  assert.match(src("lib/slack/client.ts"), /await listMembers\(userWeb\)\.catch\(\(\) => listMembers\(lookupWeb\)\)/,
    "group-DM members: your token first (the bot usually isn't in your group DMs), then the bot's");
});

// ── Zoom ─────────────────────────────────────────────────────────────────────

test("a Zoom meeting fetched from the API records contact with every participant, by email", async () => {
  const touches = [];
  const Z = loadTs("lib/zoom/process-meeting.ts", {
    "@/lib/ai/generate": {}, "@/lib/ai/model-config": {}, "@/lib/ai/parse-json": {}, "@/lib/ai/schemas": {},
    "@/lib/actions/store": {}, "@/lib/decisions/store": {}, "@/lib/contacts/tone-store": {}, "@/lib/ai/system-prompt": {},
    "@/lib/memory/store": { createMemory: async () => ({ id: "m" }) },
    "@/lib/trust/policy": { actionTier: () => "auto", decisionTier: () => "auto", memoryTier: () => "auto", needsReviewFlag: () => false },
    "@/lib/contacts/touch-recency": { touchContactsRecency: async (_u, t) => { touches.push(...t); return t.length; } },
  });
  await Z.processZoomMeeting({
    username: "u",
    meeting: { id: "9", uuid: "x", topic: "AG weekly", startTime: "2026-10-06T14:00:00Z", duration: 45, hostId: "h", type: 2 },
    participants: [{ name: "Matt P.", email: "matthew@partner.invalid" }, { name: "Priya N" }],
  }).catch(() => {});
  assert.equal(JSON.stringify(touches), JSON.stringify([
    { name: "Matt P.", email: "matthew@partner.invalid", date: "2026-10-06T14:45:00.000Z", source: "zoom" },
    { name: "Priya N", date: "2026-10-06T14:45:00.000Z", source: "zoom" },
  ]));
});

test("Zoom is asked for meetings you joined, falling back to hosted-only", () => {
  const s = src("lib/zoom/client.ts");
  assert.match(s, /const data = \(await report\("pastJoined"\)\) \?\? \(await report\("past"\)\);/);
});

// ── What counts as a relationship risk ───────────────────────────────────────

const E = loadTs("lib/today/executive.ts");
const change = (name, delta) => ({
  kind: "change", id: name, rank: 1, lane: "watch", title: "t", subtitle: "", occurredAt: "2026-10-06T00:00:00Z",
  change: { category: "relationship", subject: name, entityId: name, source: "contacts", ...(delta ? { delta } : {}) },
});

test("a warming tone is good news, not a risk; cooling and silence are named separately", () => {
  assert.equal(E.isRelationshipRisk(change("Ana", { field: "tone", to: "warming" })), false);
  assert.equal(E.isRelationshipRisk(change("Bo", { field: "tone", to: "cooling" })), true);
  assert.equal(E.isRelationshipRisk(change("Cy")), true);
  assert.equal(
    E.relationshipWhy([change("Bo", { field: "tone", to: "cooling" }), change("Cy"), change("Di")]),
    "Tone cooling with Bo. No recent contact with Cy, Di.",
    "it used to say 'No meaningful contact recently' about someone flagged only for tone",
  );
});

test("the People page shows the newer of the live scan and the stored date", () => {
  const s = src("app/api/contacts/activity/route.ts");
  assert.match(s, /const lastInteraction = live && stored\s*\? \(new Date\(live\)\.getTime\(\) >= new Date\(stored\)\.getTime\(\) \? live : stored\)\s*: live \?\? stored;/);
});

// ── Per-contact Slack recency (widened scan) ─────────────────────────────────

const R = loadTs("lib/slack/contact-recency.ts", {
  "@/lib/slack/client": {}, "@/lib/contacts/user-store": {},
});
const SELF = "UME00001";
const members = [
  { id: SELF, name: "fixture", real_name: "Fixture Owner", profile: { email: "me@fixture.invalid" } },
  { id: "UMAT0001", name: "matt.p", real_name: "Matt P.", profile: { email: "matthew@partner.invalid" } },
  { id: "UPRI0001", name: "priya", real_name: "Priya Nandakumar", profile: {} },
  { id: "USAM0001", name: "sam1", real_name: "Sam Patel" }, { id: "USAM0002", name: "sam2", real_name: "Sam Patel" },
  { id: "UBOT0001", name: "bot", real_name: "Priya Nandakumar", is_bot: true },
];
const contacts = [
  { id: "c1", name: "Matthew Paquette", email: "matthew@partner.invalid", lastInteraction: "2026-09-01T00:00:00Z" },
  { id: "c2", name: "Priya Nandakumar", lastInteraction: "2026-08-01T00:00:00Z" },
  { id: "c3", name: "Sam Patel" },
  { id: "c4", name: "Ed Baum" },
];

test("contacts match Slack users by email, else a unique full name — never a bot, never an ambiguous name", () => {
  const m = R.matchContactsToSlack(contacts, members);
  assert.equal(JSON.stringify([...m]), JSON.stringify([["c1", "UMAT0001"], ["c2", "UPRI0001"]]));
});

test("what counts as talking WITH you, and who your own messages were to", () => {
  assert.ok(R.countsAsContactWithYou({ channel: { is_im: true } }, SELF));
  assert.ok(R.countsAsContactWithYou({ channel: { is_mpim: true } }, SELF));
  assert.ok(R.countsAsContactWithYou({ channel: { name: "general" }, permalink: "https://x.slack.com/archives/C1/p1?thread_ts=1.2&cid=C1" }, SELF), "a thread reply");
  assert.ok(R.countsAsContactWithYou({ channel: { name: "general" }, text: `ping <@${SELF}>` }, SELF), "a mention of you");
  assert.ok(!R.countsAsContactWithYou({ channel: { name: "general" }, text: "deploy done" }, SELF), "a broadcast post is not contact");
  const byUser = new Map(members.map((x) => [x.name, x.id]));
  assert.equal(R.counterpartsOf({ channel: { is_im: true, name: "UMAT0001" } }, SELF, byUser).join(), "UMAT0001");
  assert.equal(R.counterpartsOf({ channel: { is_mpim: true, name: "mpdm-fixture--matt.p--priya-1" } }, SELF, byUser).sort().join(), "UMAT0001,UPRI0001");
  assert.equal(R.counterpartsOf({ channel: { name: "general" }, text: "thanks <@UPRI0001|priya>" }, SELF, byUser).join(), "UPRI0001");
});

function fakeSlack(searchResults, { rateLimitAfter = Infinity } = {}) {
  const queries = [];
  const user = {
    auth: { test: async () => ({ user_id: SELF }) },
    users: { list: async () => ({ members }) },
    search: { messages: async ({ query, page }) => {
      queries.push(`${query}#${page}`);
      if (queries.length > rateLimitAfter) { const e = new Error("rate limited"); e.code = "slack_webapi_rate_limited_error"; throw e; }
      return { messages: { matches: searchResults(query, page) } };
    } },
  };
  return { user, queries };
}

test("the scan credits DMs and threads in both directions — newest wins, no message text kept", async () => {
  const ts = (iso) => String(Date.parse(iso) / 1000);
  const slack = fakeSlack((q) => {
    if (q.startsWith("from:me")) return [
      { ts: ts("2026-10-07T09:00:00Z"), channel: { is_im: true, name: "UMAT0001" }, text: "see you at 3" },
      { ts: ts("2026-10-05T09:00:00Z"), channel: { is_mpim: true, name: "mpdm-fixture--priya--matt.p-1" }, text: "agenda attached" },
    ];
    if (q.startsWith("from:<@UPRI0001>")) return [
      { ts: ts("2026-10-08T10:00:00Z"), channel: { name: "announcements" }, text: "launch is live" },
      { ts: ts("2026-10-06T10:00:00Z"), channel: { name: "general" }, permalink: "https://x/p1?thread_ts=1.1", text: "agreed" },
    ];
    return [];
  });
  const out = await R.scanSlackContactRecency("u", { paceMs: 0, now: Date.parse("2026-10-09T05:45:00Z") }, { user: slack.user, bot: null, contacts });
  assert.equal(JSON.stringify(out.touches), JSON.stringify([
    { name: "Matthew Paquette", email: "matthew@partner.invalid", date: "2026-10-07T09:00:00.000Z", source: "slack" },
    { name: "Priya Nandakumar", date: "2026-10-06T10:00:00.000Z", source: "slack" },
  ]), "Priya's broadcast post on the 8th doesn't count; her thread reply on the 6th does");
  assert.equal(out.matchedContacts, 2);
  assert.match(slack.queries[0], /^from:me after:2026-09-09#1$/);
  assert.equal(slack.queries.slice(1).join(), "from:<@UPRI0001> after:2026-09-09#1,from:<@UMAT0001> after:2026-09-09#1", "stalest contact first");
});

test("the scan stops on a rate limit and keeps what it found; no user token means no scan", async () => {
  const ts = String(Date.parse("2026-10-07T09:00:00Z") / 1000);
  const slack = fakeSlack((q) => q.startsWith("from:me") ? [{ ts, channel: { is_im: true, name: "UMAT0001" } }] : [], { rateLimitAfter: 1 });
  const out = await R.scanSlackContactRecency("u", { paceMs: 0 }, { user: slack.user, bot: null, contacts });
  assert.equal(out.stoppedEarly, true);
  assert.equal(out.touches.length, 1);
  const none = await R.scanSlackContactRecency("u", { paceMs: 0 }, { user: null, bot: null, contacts });
  assert.equal(none.touches.length, 0);
  assert.match(src("app/api/events/poll-ingest/route.ts"), /\.\.\.slackScan\.touches\]/);
});
