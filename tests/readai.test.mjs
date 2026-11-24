/**
 * Read AI (2026-11-24): OAuth (meeting:read) + REST API → Basil's upload pipeline.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadTs } from "./_helpers/load-ts.mjs";

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const C = loadTs("lib/readai/client.ts", { "server-only": {}, "@/lib/readai/oauth": { readAiAccessToken: async () => "t", ReadAiAuthError: class extends Error {} } });
const S = loadTs("lib/readai/sync.ts", {
  "server-only": {},
  "@/lib/storage/user-store": { readUserStore: async () => ({ processed: {} }), updateUserStore: async () => ({}) },
  "@/lib/uploads/store": { saveUpload: async () => {}, saveUploadText: async () => {}, patchUpload: async () => null },
  "@/lib/uploads/process": { analyseUploadText: async () => {} },
  "@/lib/uploads/shape": loadTs("lib/uploads/shape.ts"),
  "@/lib/readai/client": C,
});

const RAW = {
  id: "01H", title: "Acme weekly", start_time_ms: 1_733_800_000_000, end_time_ms: 1_733_803_600_000,
  participants: [{ name: "Jane Doe", email: "Jane@Acme.com", attended: true }, { name: "No Show", email: "x@y.com", attended: false }],
  report_url: "https://app.read.ai/analytics/meetings/01H",
  summary: "Reviewed timelines.",
  action_items: [{ text: "Jane to send the contract" }, "Michael to book the demo"],
  key_questions: [{ question: "Who signs off?" }],
  topics: ["Pricing"],
  transcript: { turns: [{ speaker: { name: "Jane Doe" }, text: "Let's start.", start_time_ms: 1_733_800_005_000, end_time_ms: 1_733_800_008_000 }] },
  metrics: { read_score: 0.9, sentiment: 0.3, engagement: 0.75 },
};

test("a meeting is read defensively: participants, transcript turns, action items as strings or objects", () => {
  const m = C.toMeeting(RAW);
  assert.equal(m.title, "Acme weekly");
  assert.equal(m.participants[0].email, "jane@acme.com");
  assert.deepEqual([...m.actionItems], ["Jane to send the contract", "Michael to book the demo"]);
  assert.deepEqual([...m.keyQuestions], ["Who signs off?"]);
  assert.equal(m.turns[0].speaker, "Jane Doe");
  assert.equal(m.metrics.engagement, 0.75);
  assert.equal(C.toMeeting({ title: "no id" }), null);
});

test("sync: turns become seconds from the start with the speaker; Read's notes go in as context", () => {
  const m = C.toMeeting(RAW);
  const segs = S.segmentsOf(m);
  assert.equal(segs[0].start, 5);
  assert.equal(segs[0].text, "Jane Doe: Let's start.");
  const ctx = S.readAiContext(m);
  assert.match(ctx, /transcript below is the source of truth/);
  assert.match(ctx, /Action items:\n- Jane to send the contract/);
});

test("wiring: meeting:read only, PKCE + state, daily cron, report link instead of a download", () => {
  const o = src("lib/readai/oauth.ts");
  assert.match(o, /SCOPES = "openid email profile offline_access meeting:read"/);
  assert.match(o, /code_challenge_method: "S256"/);
  assert.match(src("app/api/auth/readai/callback/route.ts"), /verifyOAuthState\("readai"/);
  assert.match(src("vercel.json"), /"\/api\/cron\/readai-sync"/);
  assert.match(src("app/dashboard/uploads/page.tsx"), /Read report/);
  assert.match(src("lib/readai/sync.ts"), /participantEmails/);
});
