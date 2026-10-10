// "Where is the tone and sentiment tracking for each relationship?" (2026-10-10).
// It existed only as occasional "shifts" (6 of 23 contacts, newest mid-Sept) in
// a card hidden on the Activity tab. Now every relationship with enough recent
// contact gets a read from Slack + email; and hovering a name lights up its
// bubble on the People page.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { loadTs } from "./_helpers/load-ts.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const NOW = Date.parse("2026-10-10T12:00:00Z");
const daysAgo = (d) => new Date(NOW - d * 86_400_000).toISOString();

function sentiment(store = {}) {
  const files = { "contact-sentiment.json": structuredClone(store) };
  const S = loadTs("lib/contacts/sentiment.ts", {
    zod: require("zod"),
    "@/lib/storage/user-store": {
      readUserStore: async (_u, f, fb) => structuredClone(files[f] ?? fb),
      updateUserStore: async (_u, f, mut, fb) => { files[f] = mut(structuredClone(files[f] ?? fb)); return files[f]; },
    },
    "@/lib/events/store": { listEvents: async () => [] },
    "@/lib/contacts/user-store": { listUserContacts: async () => [] },
    "@/lib/contacts/overrides-store": { getAllOverridesFromStore: async () => ({}) },
    "@/lib/self-identity": { getSelfIdentity: async () => ({ names: ["michael cook"], emails: [] }) },
    "@/lib/slack/client": { getRecentSlackMessages: async () => [] },
    "@/lib/google/gmail": { getRecentEmails: async () => [] },
    "@/lib/ai/generate": { generateTextSafe: async () => { throw new Error("no model in tests"); } },
    "@/lib/ai/model-config": { getTextModel: () => "fast" },
    "@/lib/ai/parse-json": loadTs("lib/ai/parse-json.ts", { zod: require("zod") }),
  });
  return { S, files };
}

const slack = (o) => ({ id: o.date, channel: "#general", author: "Someone", text: "hi", isMention: false, fromSelf: false, ...o });
const CARTER = { id: "carter", name: "Carter Lusher - Lusher Advisory", email: "carter@lusher.invalid" };
const ED = { id: "ed", name: "Ed Baum" };

test("interactions: direct contact first, channel posts only fill gaps, the user's DMs to them count", () => {
  const { S } = sentiment();
  const src = {
    slack: [
      slack({ date: daysAgo(1), channel: "DM: Ed Baum", channelMembers: ["ed"], author: "Ed Baum", text: "Thanks, that landed well" }),
      slack({ date: daysAgo(2), channel: "DM: Ed Baum", channelMembers: ["ed"], author: "Michael Cook", fromSelf: true, text: "Sent the deck" }),
      slack({ date: daysAgo(3), channel: "#tg-gtm", author: "Ed Baum", text: "Partner update posted" }),
      slack({ date: daysAgo(1), channel: "#tg-gtm", author: "Ed Bauman", text: "Different person" }),
      slack({ date: daysAgo(40), channel: "DM: Ed Baum", channelMembers: ["ed"], author: "Ed Baum", text: "Too old" }),
      slack({ date: daysAgo(1), channel: "DM: Edwina Baum", channelMembers: ["edwina"], author: "Edwina Baum", text: "Not Ed" }),
    ],
  };
  const ix = S.interactionsWith(ED, src, ["michael cook"], NOW);
  assert.equal(ix.map((i) => i.text).join(" | "), "Thanks, that landed well | Sent the deck | Partner update posted");
  assert.equal(ix[1].mine, true);
  assert.equal(ix[2].source, "slack #tg-gtm", "a channel post says where it was");
});

test("interactions: email by address, names with a company suffix, and stored events", () => {
  const { S } = sentiment();
  const ix = S.interactionsWith(CARTER, {
    emails: [{ from: "Carter Lusher", fromEmail: "Carter@Lusher.invalid", subject: "Briefing", snippet: "Loved the session", date: daysAgo(2) },
             { from: "Carter Smith", fromEmail: "cs@other.invalid", subject: "x", snippet: "y", date: daysAgo(2) }],
    events: [{ source: "zoom", createdAt: daysAgo(5), payload: { from: "Carter Lusher", title: "Recap", body: "Enthusiastic about the pilot" } }],
  }, ["michael cook"], NOW);
  assert.equal(ix.map((i) => i.source).join(","), "email,zoom");
});

test("a read is judged once, reused until something new AND a day has passed, and fails safe", async () => {
  const { S, files } = sentiment();
  const sources = { slack: [
    slack({ date: daysAgo(1), channel: "DM: Ed Baum", channelMembers: ["ed"], author: "Ed Baum", text: "Great work on this" }),
    slack({ date: daysAgo(3), channel: "DM: Ed Baum", channelMembers: ["ed"], author: "Ed Baum", text: "Can we sync?" }),
  ] };
  let calls = 0; let prompt = "";
  const judge = async (p) => { calls++; prompt = p; return { tone: "warm", trend: "warming", summary: "Ed is upbeat.", evidence: [{ date: "2026-10-09", source: "slack", note: "Great work" }] }; };
  const opts = { sources, selfNames: ["michael cook"], shifts: [], judge, now: NOW };
  const r1 = await S.assessRelationship("u", ED, opts);
  assert.equal(r1.sentiment.tone, "warm");
  assert.equal(calls, 1);
  assert.match(prompt, /Ed Baum: Great work on this/);
  assert.match(prompt, /Michael/, "the user is named in the prompt");
  assert.equal(files["contact-sentiment.json"].ed.basedOn, 2);

  await S.assessRelationship("u", ED, opts);
  assert.equal(calls, 1, "nothing new → stored read");

  const newer = { slack: [slack({ date: new Date(NOW + 3600_000).toISOString(), channel: "DM: Ed Baum", channelMembers: ["ed"], author: "Ed Baum", text: "One more thing" }), ...sources.slack] };
  await S.assessRelationship("u", ED, { ...opts, sources: newer, now: NOW + 2 * 3600_000 });
  assert.equal(calls, 1, "something new, but read under a day ago → stored read (cost cap)");
  await S.assessRelationship("u", ED, { ...opts, sources: newer, now: NOW + 25 * 3600_000 });
  assert.equal(calls, 2, "new and over a day → re-read");

  const broken = await S.assessRelationship("u", ED, { ...opts, force: true, judge: async () => null });
  assert.equal(broken.sentiment.tone, "warm", "a failed read keeps the last good one");
});

test("too little contact → no read, and the count says why", async () => {
  const { S } = sentiment();
  const r = await S.assessRelationship("u", ED, { sources: { slack: [slack({ date: daysAgo(1), channel: "DM: Ed Baum", channelMembers: ["ed"], author: "Ed Baum" })] }, selfNames: [], shifts: [], judge: async () => { throw new Error("must not be called"); }, now: NOW });
  assert.equal(r.sentiment, null);
  assert.equal(r.interactions, 1);
});

test("People page: tone card leads the Profile tab; hover links names and bubbles", () => {
  const page = src("app/dashboard/contacts/page.tsx");
  const profile = page.slice(page.indexOf('<TabsContent value="profile"'), page.indexOf('<TabsContent value="personality"'));
  assert.match(profile, /<RelationshipToneCard /);
  assert.doesNotMatch(page, /Tone &amp; Attitude/, "the old card hidden on the Activity tab is gone");
  assert.match(page, /onMouseEnter=\{\(\) => onHover\?\.\(c\.id\)\}/, "list rows report hover");
  assert.match(page, /onMouseEnter=\{\(\) => setHoveredId\(c\.id\)\}/, "bubbles report hover");
  assert.match(page, /hoveredId === c\.id \? "relative z-10 scale-125/, "the hovered contact's bubble is highlighted");
  assert.match(page, /hovered=\{hoveredId\} onHover=\{setHoveredId\}/);
});
