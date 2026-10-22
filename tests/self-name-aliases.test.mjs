// The user goes by several names in meeting notes: Michael, Michael Cook,
// Mike Cook, Mike C, Michael C — and bare "Mike" when no other Mike is on the
// call. Each must count as the user; none may claim someone else ("Mike
// Collins", the colleague "Mike" in a standup that also mentions Michael).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadTs } from "./_helpers/load-ts.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const users = { michael: { username: "michael", name: "Michael", surname: "Cook", email: "michael@work.example", aliasEmails: ["michael@alias.example"] } };
const S = loadTs("lib/self-identity.ts", { "@/lib/users": { findByUsername: async (u) => users[u] ?? null } });

test("every listed form of the name is the user", async () => {
  const id = await S.getSelfIdentity("michael");
  for (const n of ["Michael", "Michael Cook", "Mike Cook", "Mike C", "Michael C", "Mike C.", "michael@alias.example"]) {
    assert.equal(S.isSelf(n, id), true, n);
  }
});

test("…and nobody else: forms match whole names only, and bare Mike needs context", async () => {
  const id = await S.getSelfIdentity("michael");
  for (const n of ["Mike", "Mike Collins", "Michael Smith", "Mick Jagger", "Ed Baum"]) {
    assert.equal(S.isSelf(n, id), false, n);
  }
  assert.equal(id.names.length, 1, "first-word callers still see only the full name");
});

test("bare Mike is the user when the notes never mention Michael or another Mike", async () => {
  const id = await S.getSelfIdentity("michael");
  const solo = S.selfInContext(id, "Mike described his goal of building a coaching business. Mike was interested but wants to review the materials.");
  assert.equal(S.isSelf("Mike", solo), true);
  const withMichael = S.selfInContext(id, "Mike will investigate tracking and send Michael filtered analytics snapshots.");
  assert.equal(S.isSelf("Mike", withMichael), false, "Michael is the user here, so Mike is the colleague");
  const otherMike = S.selfInContext(id, "Mike Smith will chase procurement; Mike will draft the deck.");
  assert.equal(S.isSelf("Mike", otherMike), false, "another Mike named on the call");
  const mikeCook = S.selfInContext(id, "Mike Cook reported a podcast; Mike will publish it.");
  assert.equal(S.isSelf("Mike", mikeCook), true, "Mike Cook is the user's own surname");
});

test("with another Mike in contacts, bare Mike is the user only when Zoom's participant list rules him out", async () => {
  const id = await S.getSelfIdentity("michael");
  const text = "Mike will validate the PostHog cohort approach with Christopher.";
  const others = ["Mike Trujillo", "Ed Baum"];
  assert.equal(S.isSelf("Mike", S.selfInContext(id, text, { otherPeople: others })), false, "no participant list (the digest): left as written");
  assert.equal(S.isSelf("Mike", S.selfInContext(id, text, { otherPeople: others, attendees: ["Ed Baum", "Mike Trujillo", "Michael Cook"] })), false, "he was on the call");
  assert.equal(S.isSelf("Mike", S.selfInContext(id, text, { otherPeople: others, attendees: ["Ed Baum", "Olivia Bond-Keith", "Michael Cook"] })), true, "he was not: Mike is the user");
  assert.equal(S.isSelf("Mike", S.selfInContext(id, text, { otherPeople: ["Michael Cook", "Ed Baum"] })), true, "the user's own contact card is not a namesake");
});

test("an owner under another name is filed under the display name", async () => {
  const id = await S.getSelfIdentity("michael");
  assert.equal(S.normaliseOwner("Mike Cook", id), "Michael Cook");
  assert.equal(S.normaliseOwner("Mike C", id), "Michael Cook");
  assert.equal(S.normaliseOwner("Ed Baum", id), "Ed Baum");
  assert.equal(S.normaliseOwner("Mike", id), "Mike", "bare Mike without context stays as written");
  assert.equal(S.normaliseOwner("Mike", S.selfInContext(id, "Mike agreed to review it.")), "Michael Cook");
});

test("name forms come from the user's own name, not a hardcoded person", () => {
  const j = (x) => JSON.stringify(x);
  assert.equal(j([...S.nameForms("Michael", "Cook").aliases].sort()), j(["michael", "michael c", "mick c", "mick cook", "mike c", "mike cook"]));
  assert.equal(j(S.nameForms("Michael", "Cook").nicknames), j(["mike", "mick"]));
  assert.equal(j(S.nameForms("Priya", "Shah")), j({ aliases: ["priya", "priya s"], nicknames: [] }));
});

test("actions, meeting notes and attendees all use it", () => {
  const store = src("lib/actions/store.ts");
  assert.match(store, /const owner = selfIdentity \? normaliseOwner\(rawInput\.owner, selfIdentity\) : rawInput\.owner;/);
  assert.match(store, /if \(isSelf\(owner, selfIdentity\)\) return false;/, "the owner filter never drops the user's own actions");
  const p = src("lib/email/process-gmail-message.ts");
  assert.match(p, /const meetingIdentity = selfInContext\(selfIdentity, plainBody, \{\s*otherPeople:/);
  assert.doesNotMatch(p, /attendees: extract\.attendees/, "a summary's names are not a participant list");
  const zm = src("lib/zoom/process-meeting.ts");
  assert.match(zm, /attendees: attendeeNames,/, "the API path has Zoom's real participants");
  assert.match(zm, /owner:\s+normaliseOwner\(item\.owner, meetingIdentity\) \?\? "Unknown"/);
  assert.match(p, /owner: normaliseOwner\(item\.owner, meetingIdentity\)/);
  assert.match(p, /\.filter\(\(a\) => a\.trim\(\) && !isSelf\(a, meetingIdentity\)\)/, "the user is never logged as their own meeting contact");
  const U = loadTs("lib/actions/utils.ts", new Proxy({}, { get: () => ({}) }));
  assert.equal(U.ownerOfMeetingNote("Mike C to send the deck", ["michael cook"])?.owner, "Mike C", "an initial is part of the name");
});
