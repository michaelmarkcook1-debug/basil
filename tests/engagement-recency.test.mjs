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
  assert.match(src("lib/slack/client.ts"), /await \(userWeb \?\? lookupWeb\)\.conversations\.members\(/,
    "group-DM members are read with your token — the bot usually isn't in your group DMs");
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
