// Settings → "Read tone & sentiment for my relationships". Off must stop the
// work at the source — no model reads, no stored tone shifts — not just hide it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { loadTs } from "./_helpers/load-ts.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

function sentimentModule(toneSentiment) {
  const calls = { model: 0 };
  const S = loadTs("lib/contacts/sentiment.ts", {
    zod: require("zod"),
    "@/lib/storage/user-store": { readUserStore: async (_u, _f, fb) => fb, updateUserStore: async (_u, _f, mut, fb) => mut(fb) },
    "@/lib/events/store": { listEvents: async () => [] },
    "@/lib/contacts/user-store": { listUserContacts: async () => [{ id: "c1", name: "Priya Shah" }] },
    "@/lib/contacts/overrides-store": { getAllOverridesFromStore: async () => ({}) },
    "@/lib/self-identity": { getSelfIdentity: async () => ({ names: ["michael cook"], emails: [] }) },
    "@/lib/slack/client": { getRecentSlackMessages: async () => Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, channel: "DM: Priya Shah", author: "Priya Shah", text: "hello again", date: new Date(Date.now() - i * 864e5).toISOString(), isMention: true, fromSelf: false, channelMembers: 2 })) },
    "@/lib/google/gmail": { getRecentEmails: async () => [] },
    "@/lib/ai/generate": { generateTextSafe: async () => { calls.model++; return { text: '{"tone":"warm","trend":"steady","summary":"x","evidence":[]}' }; } },
    "@/lib/ai/model-config": { getTextModel: () => "fast" },
    "@/lib/ai/parse-json": loadTs("lib/ai/parse-json.ts", { zod: require("zod") }),
    "@/lib/contacts/relationship-signals": loadTs("lib/contacts/relationship-signals.ts"),
    "@/lib/settings/store": { getSettings: async () => ({ toneSentiment }) },
  });
  return { S, calls };
}

test("the setting defaults to on, and off is explicit", async () => {
  assert.equal(await sentimentModule(undefined).S.toneSentimentEnabled("u"), true);
  assert.equal(await sentimentModule(true).S.toneSentimentEnabled("u"), true);
  assert.equal(await sentimentModule(false).S.toneSentimentEnabled("u"), false);
});

test("off: the daily refresh reads nobody and never calls the model", async () => {
  const { S, calls } = sentimentModule(false);
  assert.equal(await S.refreshStaleSentiment("u"), 0);
  assert.equal(calls.model, 0);
});

test("on: the same refresh does read the relationship", async () => {
  const { S, calls } = sentimentModule(true);
  assert.equal(await S.refreshStaleSentiment("u"), 1);
  assert.equal(calls.model, 1);
});

test("off: tone shifts noticed by the message classifiers are not stored", async () => {
  let writes = 0;
  const T = loadTs("lib/contacts/tone-store.ts", {
    "@/lib/contacts-data": { sampleContacts: () => [] },
    "@/lib/contacts/user-store": { listUserContacts: async () => [{ id: "c1", name: "Priya Shah" }] },
    "@/lib/contacts/overrides-store": { appendToneObservation: async () => { writes++; } },
    "@/lib/settings/store": { getSettings: async () => ({ toneSentiment: false }) },
  });
  await T.writeToneObservations("u", [{ person: "Priya Shah", direction: "cooling", summary: "curt" }], "2026-10-21", "email", "gmail:1");
  assert.equal(writes, 0);
});

test("the route, the Settings page and the API schema all carry the switch", () => {
  const route = src("app/api/contacts/sentiment/route.ts");
  assert.match(route, /toneSentimentEnabled\(username\)/, "GET must check the switch before any read");
  assert.match(route, /disabled: true/, "the off state is told to the UI, not faked as 'no messages'");
  assert.match(src("app/api/settings/route.ts"), /toneSentiment: z\.boolean\(\)/);
  const page = src("app/dashboard/settings/page.tsx");
  assert.match(page, /Read tone &amp; sentiment for my relationships/);
  assert.match(page, /toneSentiment: draft\.toneSentiment \?\? true/, "the save handler must send it");
  assert.match(src("components/contacts/relationship-tone.tsx"), /data\.disabled/, "the profile card explains the off state");
});
