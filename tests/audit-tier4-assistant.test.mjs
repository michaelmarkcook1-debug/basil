/**
 * Phase 4 — assistant reliability. Real routes and libs; provider, storage
 * and auth mocked. The AI SDK itself is the real installed package where its
 * behaviour is what is under test (message conversion).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { loadTs, nextServer } from "./_helpers/load-ts.mjs";

const require = createRequire(import.meta.url);
const ai = require("ai");
const plain = (v) => structuredClone(v);

// ── AI-01: no hold is taken for a request that is refused ────────────────────

function chatRoute({ reserve, release, setupThrows = false }) {
  return loadTs("app/api/chat/route.ts", {
    "@/lib/trust/ledger": { getDelegations: async () => new Set(), recordApprovalResponses: async () => 0, recordDelegatedRuns: async () => 0 },
    ai: { ...ai, streamText: () => ({ toUIMessageStreamResponse: () => new Response("ok"), consumeStream: async () => {} }) },
    "@/lib/ai/model-config": { getChatModel: () => "mock-model", MAX_TOKENS: { default: 1, balanced: 1, long: 1, fast: 1 }, PROVIDER_MODE: "openai_direct" },
    "@/lib/ai/system-prompt": { getChatPromptParts: async () => ({ instructions: "sys", turnContext: "ctx" }) },
    "@/lib/ai/prompt-cache": loadTs("lib/ai/prompt-cache.ts"),
    "@/lib/ai/tools": { buildAssistantTools: () => ({}) },
    "@/lib/auth": { getSessionUser: async () => "fixture" },
    "@/lib/settings/store": { getSettings: async () => { if (setupThrows) throw new Error("settings store down"); return { name: "Fixture User" }; } },
    "@/lib/timezone": { resolveTimezone: () => "Europe/London" },
    "@/lib/rate-limit": { checkRateLimitDurable: async () => ({ allowed: true }), getClientIp: () => "203.0.113.1" },
    "@/lib/ai/repair-history": loadTs("lib/ai/repair-history.ts"),
    "@/lib/ai/spend-guard": {
      reserveSpend: async (...a) => { reserve.push(a); return { username: "fixture", feature: "chat", family: "opus5", reservedUsd: 0.27, heldKeys: ["k"] }; },
      commitSpend: async () => {}, releaseSpend: async (r) => { release.push(r); },
      SpendCapError: class extends Error {}, spendCapResponse: () => new Response("cap", { status: 429 }),
    },
    "@/lib/billing/entitlement-store": { getEntitlement: async () => ({ plan: "pro", aiMonthlyUsd: 10 }) },
    "@/lib/ai/tiering": { effectiveKind: () => "default" },
    "@/lib/ai/pricing": { CHAT_PRICE_FAMILY: "opus5", costUsd: () => 0 },
  });
}
const req = (body, raw = false) => new Request("http://fixture.invalid/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: raw ? body : JSON.stringify(body) });

test("AI-01 an invalid body is refused before any budget is held", async () => {
  const reserve = [], release = [];
  const route = chatRoute({ reserve, release });
  const bad = await route.POST(req({ messages: "not-an-array" }));
  assert.equal(bad.status, 400);
  const notJson = await route.POST(req("{oops", true));
  assert.equal(notJson.status, 400);
  assert.equal(reserve.length, 0, "no reservation for a refused request");
});

test("AI-01 a hold taken before setup is released when setup throws", async () => {
  const reserve = [], release = [];
  const route = chatRoute({ reserve, release, setupThrows: true });
  await assert.rejects(route.POST(req({ messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }] })), /settings store down/);
  assert.equal(reserve.length, 1);
  assert.equal(release.length, 1, "the reservation must go back");
});

// ── AI-03 + the reservation contract ─────────────────────────────────────────

function generateModule({ committed, generateText }) {
  return loadTs("lib/ai/generate.ts", {
    ai: { generateText, streamText: () => ({}), stepCountIs: ai.stepCountIs },
    "@/lib/ai/model-config": { getTextModel: () => "mock", getDirectAnthropicModel: () => null, getDirectOpenAIModel: () => null, preferOpenAI: () => false, PROVIDER_MODE: "openai_direct" },
    "@/lib/ai/spend-guard": {
      reserveSpend: async () => ({ username: "f", feature: "t", family: "opus5", reservedUsd: 0.10, heldKeys: [] }),
      commitSpend: async (_r, u) => { committed.push(u); }, releaseSpend: async () => {},
    },
    "@/lib/ai/pricing": loadTs("lib/ai/pricing.ts", { "./model-config": { RESERVE_OUTPUT_TOKENS: { fast: 1, default: 1, long: 1 } } }),
  });
}

test("AI-03 the wrapper commits all-step usage, not the final step's", async () => {
  const committed = [];
  const G = generateModule({ committed, generateText: async () => ({ text: "done", usage: { inputTokens: 100, outputTokens: 10 }, totalUsage: { inputTokens: 500, outputTokens: 50 } }) });
  await G.generateTextSafe({ prompt: "x" }, "default", { username: "f", feature: "t", maxSteps: 5 });
  assert.deepEqual(plain(committed[0]), { inputTokens: 500, outputTokens: 50 });
});

test("reservation contract: a metered call stops its loop when accumulated cost reaches the hold", async () => {
  let seen;
  const G = generateModule({ committed: [], generateText: async (opts) => { seen = opts; return { text: "", usage: {}, totalUsage: {} }; } });
  await G.generateTextSafe({ prompt: "x", stopWhen: ai.stepCountIs(5) }, "default", { username: "f", feature: "t", maxSteps: 5 });
  assert.ok(Array.isArray(seen.stopWhen) && seen.stopWhen.length === 2, "caller's stopWhen kept, ceiling appended");
  const ceiling = seen.stopWhen[1];
  // opus5 = $5/M in, $25/M out. Two steps of 4 000 output tokens = $0.20 > $0.10 hold.
  const step = { usage: { inputTokens: 0, outputTokens: 4000 } };
  assert.equal(await ceiling({ steps: [step] }), true, "one $0.10 step already reaches a $0.10 hold");
  assert.equal(await ceiling({ steps: [{ usage: { inputTokens: 0, outputTokens: 100 } }] }), false, "$0.0025 does not");
});

test("reservation contract: observe-only (no cap) never stops, and the SDK's one-step default is preserved", async () => {
  let seen;
  const G = loadTs("lib/ai/generate.ts", {
    ai: { generateText: async (o) => { seen = o; return { text: "", usage: {} }; }, streamText: () => ({}), stepCountIs: ai.stepCountIs },
    "@/lib/ai/model-config": { getTextModel: () => "mock", getDirectAnthropicModel: () => null, getDirectOpenAIModel: () => null, preferOpenAI: () => false, PROVIDER_MODE: "openai_direct" },
    "@/lib/ai/spend-guard": { reserveSpend: async () => ({ username: "f", feature: "t", family: "haiku", reservedUsd: 0, heldKeys: [] }), commitSpend: async () => {}, releaseSpend: async () => {} },
    "@/lib/ai/pricing": { costUsd: () => 0 },
  });
  await G.generateTextSafe({ prompt: "x" }, "fast", { username: "f", feature: "t" });
  assert.equal(seen.stopWhen, undefined, "observe-only: caller's (absent) stopWhen passes through untouched");
  const withHold = G.withSpendCeiling(undefined, { reservedUsd: 1, family: "haiku" });
  assert.ok(Array.isArray(withHold) && withHold.length === 2, "with a hold and no caller stopWhen: SDK default one-step + ceiling");
});

// ── SD-5: migration precedes the first Postgres read AND write ───────────────

function persistentModule(calls) {
  return loadTs("lib/storage/persistent.ts", {
    "node:fs": { promises: {} }, "./paths": { DATA_DIR: "/unused" }, "./lock": { withLock: async (_k, fn) => fn() },
    "./adapters/blob": { blobReadAllRaw: async () => { calls.push("read-blob"); return [{ scope: "", key: "secure-users.json", data: ["existing-user"] }]; }, blobIsMigrated: async () => true },
    "./adapters/filesystem": {}, "./adapters/vercel-env": { isVercelEnvAdapterAvailable: () => false },
    "./adapters/postgres": {
      isPostgresEnabled: () => true,
      pgReadJson: async (_s, _f, fallback) => { calls.push("read-postgres"); return fallback; },
      pgWriteJson: async () => { calls.push("write-postgres"); },
      pgIsMigratedFromBlob: async () => { calls.push("migration-check"); return false; },
      pgMigrateFromBlob: async () => { calls.push("migrate"); },
    },
  }, { DATABASE_URL: "fixture", BLOB_READ_WRITE_TOKEN: "fixture" });
}

test("SD-5 enabling Postgres runs the Blob→Postgres migration before the first read", async () => {
  const calls = [];
  await persistentModule(calls).readStore("secure-users.json", []);
  assert.deepEqual(calls.slice(0, 3), ["migration-check", "read-blob", "migrate"], `migration must come first; got ${calls}`);
  assert.equal(calls.at(-1), "read-postgres");
});

test("SD-5 …and before the first write", async () => {
  const calls = [];
  await persistentModule(calls).writeStore("x.json", { a: 1 });
  assert.equal(calls[0], "migration-check");
  assert.equal(calls.at(-1), "write-postgres");
});

// ── opening chat costs nothing ───────────────────────────────────────────────

test("/api/ai/status answers from configuration and never calls a model", async () => {
  let generated = 0;
  const route = loadTs("app/api/ai/status/route.ts", {
    "next/server": nextServer,
    "@/lib/auth": { getSessionUser: async () => "fixture" },
    "@/lib/ai/model-config": { PROVIDER_MODE: "openai_direct", getChatModel: () => ({ modelId: "gpt-5.6-sol" }) },
    "@/lib/ai/generate": { generateTextSafe: async () => { generated++; return {}; } },
  });
  const res = await route.GET();
  assert.equal(res.body.ok, true);
  assert.equal(res.body.model, "gpt-5.6-sol");
  assert.equal(res.body.probe, "configuration");
  assert.equal(generated, 0);
});

// ── AI-02: the calendar gets the timezone the model was told to use ──────────

test("AI-02 scheduleMeeting forwards the resolved timezone to the calendar adapter", async () => {
  let booked;
  const noop = new Proxy({}, { get: () => async () => ({}) });
  const T = loadTs("lib/ai/tools.ts", {
    ai, zod: require("zod"),
    "@/lib/security/sensitive": loadTs("lib/security/sensitive.ts"),
    "@/lib/web/search": noop, "@/lib/google/auth": { isGoogleConnected: async () => true },
    "@/lib/google/calendar": { createCalendarEvent: async (_u, params) => { booked = params; return { id: "evt", htmlLink: "https://calendar.invalid/evt" }; }, getTodayEvents: async () => [], getEventsForDate: async () => [], getEventsForDateRange: async () => [], checkFreeBusy: async () => ({}) },
    "@/lib/google/gmail": noop, "@/lib/google/drive": noop, "@/lib/slack/client": noop,
    "@/lib/memory/store": noop, "@/lib/actions/store": noop, "@/lib/decisions/store": noop,
    "@/lib/events/audit": { emitAuditEvent: async () => {} }, "@/lib/linear/sync-actions": noop, "@/lib/linear/client": noop,
    "@/lib/contacts-lookup": { findContactByName: () => undefined, timezoneFromLocation: () => undefined }, "@/lib/contacts/user-store": noop,
  });
  const tools = T.buildAssistantTools("fixture", "Fixture", "America/New_York");
  await tools.scheduleMeeting.execute({ title: "Test", attendees: ["a@example.invalid"], date: "2026-09-16", startTime: "09:00", duration: 30 }, { toolCallId: "tc", messages: [] });
  assert.equal(booked.timezone, "America/New_York", "09:00 must mean 09:00 in New York, not London");
});

// ── AI-04: mobile approvals travel both ways ─────────────────────────────────

function mobileRoute(generateTextSafe) {
  return loadTs("app/api/chat/mobile/route.ts", {
    "@/lib/trust/ledger": { getDelegations: async () => new Set(), recordApprovalResponses: async () => 0, recordDelegatedRuns: async () => 0 },
    ai,
    "@/lib/ai/generate": { generateTextSafe },
    "@/lib/ai/repair-history": loadTs("lib/ai/repair-history.ts"),
    "@/lib/ai/spend-guard": { SpendCapError: class extends Error {}, spendCapResponse: () => new Response("cap", { status: 429 }) },
    "@/lib/billing/entitlement-store": { getEntitlement: async () => ({ plan: "pro", aiMonthlyUsd: 10 }) },
    "@/lib/ai/tiering": { effectiveKind: () => "default" },
    "@/lib/ai/pricing": { CHAT_PRICE_FAMILY: "opus5" },
    "@/lib/ai/model-config": { getChatModel: () => "mock", MAX_TOKENS: { default: 1 }, PROVIDER_MODE: "openai_direct" },
    "@/lib/ai/system-prompt": { getChatPromptParts: async () => ({ instructions: "sys", turnContext: "ctx" }) },
    "@/lib/ai/prompt-cache": loadTs("lib/ai/prompt-cache.ts"),
    "@/lib/ai/tools": { buildAssistantTools: () => ({}) },
    "@/lib/auth": { getSessionUser: async () => "fixture" },
    "@/lib/settings/store": { getSettings: async () => ({ name: "Fixture User" }) },
    "@/lib/timezone": { resolveTimezone: () => "Europe/London" },
    "@/lib/rate-limit": { checkRateLimitDurable: async () => ({ allowed: true }) },
  });
}
const post = (route, messages) => route.POST(new Request("http://fixture.invalid/api/chat/mobile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages }) }));

test("AI-04 an approval request reaches the mobile client instead of an empty reply", async () => {
  const route = mobileRoute(async () => ({ text: "", content: [{ type: "tool-approval-request", approvalId: "ap-1", toolCall: { toolName: "scheduleMeeting", toolCallId: "tc-1", input: { title: "Test" } } }] }));
  const res = await post(route, [{ role: "user", content: "Schedule a test meeting" }]);
  const body = await res.json();
  assert.equal(body.approvals.length, 1);
  assert.equal(body.approvals[0].approvalId, "ap-1");
  const part = body.assistantMessage.parts.find((p) => p.type === "tool-scheduleMeeting");
  assert.equal(part.state, "approval-requested");
  assert.equal(part.approval.id, "ap-1");
});

test("AI-04 the client's decision comes back as a tool-approval-response the model can act on", async () => {
  let modelMessages;
  const route = mobileRoute(async (opts) => { modelMessages = opts.messages; return { text: "Booked.", content: [] }; });
  const assistant = { id: "asst-1", role: "assistant", parts: [
    { type: "tool-scheduleMeeting", toolCallId: "tc-1", state: "approval-responded", input: { title: "Test" }, approval: { id: "ap-1", approved: true } },
  ] };
  const res = await post(route, [{ role: "user", content: "Schedule a test meeting" }, assistant]);
  assert.equal((await res.json()).text, "Booked.");
  const wire = JSON.stringify(modelMessages);
  assert.match(wire, /tool-approval-response/, "the decision must be converted, not dropped");
  assert.match(wire, /"approvalId":"ap-1"/);
  assert.match(wire, /"approved":true/);
});
