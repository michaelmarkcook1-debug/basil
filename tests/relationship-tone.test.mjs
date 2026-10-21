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
  const fetches = { slack: 0 };
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
    "@/lib/slack/client": { getRecentSlackMessages: async () => { fetches.slack++; return []; } },
    "@/lib/google/gmail": { getRecentEmails: async () => [] },
    "@/lib/ai/generate": { generateTextSafe: async () => { throw new Error("no model in tests"); } },
    "@/lib/settings/store": { getSettings: async () => ({ toneSentiment: files.toneSentiment }) },
    "@/lib/ai/model-config": { getTextModel: () => "fast" },
    "@/lib/ai/parse-json": loadTs("lib/ai/parse-json.ts", { zod: require("zod") }),
    "@/lib/contacts/relationship-signals": loadTs("lib/contacts/relationship-signals.ts"),
  });
  return { S, files, fetches };
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
  // Since 2026-10-14 the bubbles are the drift strip ("time since you last
  // spoke"): it reports hover up and highlights the hovered/selected person.
  assert.match(page, /<DriftStrip[\s\S]*?hoveredId=\{hoveredId\}[\s\S]*?onHover=\{setHoveredId\}/, "bubbles report hover");
  const strip = src("components/contacts/drift-strip.tsx");
  assert.match(strip, /onMouseEnter=\{\(\) => onHover\(p\.id\)\}/);
  assert.match(strip, /const lit = p\.id === hoveredId \|\| p\.id === selectedId;/, "the hovered contact's bubble is highlighted");
  assert.match(page, /hovered=\{hoveredId\} onHover=\{setHoveredId\}/);
});

test("a read from the last day is returned without gathering Slack/Gmail", async () => {
  const fresh = { contactId: "ed", tone: "warm", trend: "steady", summary: "s", evidence: [], basedOn: 12, latestAt: daysAgo(1), computedAt: new Date(NOW - 3_600_000).toISOString() };
  const { S, fetches } = sentiment({ ed: fresh });
  const r = await S.assessRelationship("u", ED, { now: NOW, judge: async () => { throw new Error("must not re-read"); } });
  assert.equal(r.sentiment.tone, "warm");
  assert.equal(r.interactions, 12);
  assert.equal(fetches.slack, 0, "no 30-day Slack fetch for a read already on file");
});

test("People page shows how old each personality profile is (card + list), flagging stale ones", () => {
  const page = src("app/dashboard/contacts/page.tsx");
  assert.match(page, /Updated \{d === 0 \? "today" : `\$\{d\} day\$\{d === 1 \? "" : "s"\} ago`\}/);
  assert.match(page, /stale \? " — due a refresh" : ""/);
  assert.match(page, /\{d === null \? "no profile" : `profile \$\{d\}d`\}/);
  assert.match(page, /profileDates=\{Object\.fromEntries\(Object\.entries\(overrides\)/);
});

// ── Baseline-aware reads (2026-10-21) ────────────────────────────────────────

test("the prompt judges against the person's own baseline, carries the facts, and respects a correction", () => {
  const { S } = sentiment();
  const ix = [{ date: daysAgo(1), source: "slack", from: "Ed Baum", text: "Yes.", mine: false }];
  const baseline = { n: 24, medianWords: 3, shortShare: 0.95, medianReplyHours: 1, medianGapDays: 3 };
  const p = S.sentimentPrompt("Ed Baum", "Michael", ix, [], { baseline, facts: ["Usually writes 3 words a message (mostly one-liners).", "Replies in about 1h, as usual."], correction: { note: "Ed is always this brief", at: "2026-10-20T10:00:00Z" } });
  assert.match(p, /against Ed Baum's OWN usual style/);
  assert.match(p, /about 3 words a message, mostly one-liners/);
  assert.match(p, /Terse, direct or unpadded is NOT cool if it is how they always write/);
  assert.match(p, /Replies in about 1h, as usual/);
  assert.match(p, /corrected an earlier read of Ed Baum on 2026-10-20: "Ed is always this brief"/);
  assert.match(p, /Describe behaviour .* not inner states/);
  // No history → the prompt says so, rather than inventing a norm.
  const q = S.sentimentPrompt("Ed Baum", "Michael", ix, [], { baseline: { n: 2, medianWords: 3, shortShare: 1 } });
  assert.match(q, /no long history with Ed Baum yet, so do not treat brevity or directness as a signal/);
});

test("a read stores its confidence and facts; an early read carries no trend", async () => {
  const { S, files } = sentiment();
  const sources = { slack: [
    slack({ date: daysAgo(1), channel: "DM: Ed Baum", channelMembers: ["ed"], author: "Ed Baum", text: "ok" }),
    slack({ date: daysAgo(2), channel: "DM: Ed Baum", channelMembers: ["ed"], author: "Ed Baum", text: "fine" }),
  ] };
  const judge = async () => ({ tone: "cool", trend: "cooling", summary: "Terse.", evidence: [] });
  const r = await S.assessRelationship("u", ED, { sources, selfNames: ["michael cook"], shifts: [], judge, now: NOW });
  assert.equal(r.sentiment.confidence, "early");
  assert.equal(r.sentiment.trend, "steady", "two messages cannot establish a trend, whatever the model said");
  assert.equal(r.sentiment.facts.length, 0, "no 90-day history → no facts");
  assert.equal(files["contact-sentiment.json"].ed.confidence, "early");
});

test("a correction is stored, re-reads immediately, and reaches the prompt", async () => {
  const { S, files } = sentiment();
  const sources = { slack: Array.from({ length: 6 }, (_, i) => slack({ date: daysAgo(i * 3 + 1), channel: "DM: Ed Baum", channelMembers: ["ed"], author: "Ed Baum", text: "Noted." })) };
  let prompt = "";
  const judge = async (p) => { prompt = p; return { tone: "neutral", trend: "steady", summary: "Brief as ever.", evidence: [] }; };
  await S.assessRelationship("u", ED, { sources, selfNames: ["michael cook"], shifts: [], judge, now: NOW });
  // correctRelationship goes through the stored path; give it the same sources via the module's loader stub.
  files["contact-sentiment.json"].ed.correction = undefined;
  const after = await S.assessRelationship("u", ED, { sources, selfNames: ["michael cook"], shifts: [], judge, now: NOW + 2 * 86_400_000, force: true });
  assert.equal(after.sentiment.correction, undefined);
  files["contact-sentiment.json"].ed.correction = { note: "Ed is always this brief", at: new Date(NOW).toISOString() };
  await S.assessRelationship("u", ED, { sources, selfNames: ["michael cook"], shifts: [], judge, now: NOW + 3 * 86_400_000, force: true });
  assert.match(prompt, /corrected an earlier read of Ed Baum .*"Ed is always this brief"/);
  assert.equal(files["contact-sentiment.json"].ed.correction.note, "Ed is always this brief", "the correction survives re-reads");
});
