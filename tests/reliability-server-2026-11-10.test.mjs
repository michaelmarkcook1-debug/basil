// The 2026-11-10 bug pass (basil-bug-pass-2026-11-10.md), server reliability
// items. Each was re-read in the code before it was fixed; each test runs the
// real module through loadTs with its boundaries mocked.
//  A6  Reconnecting Google and picking another user's account deleted the
//      working connection; a failed address lookup skipped the ownership check.
//  A7  A tool loop that failed after a step (or an approved tool) ran was
//      replayed on the fallback provider — the tool ran twice. Mobile chat's
//      per-attempt ceiling was sized for one model call, not a tool loop.
//  A10 Account deletion did not wait for the data purge, and left the Google
//      and Slack grants alive at the provider.
//  A11 forgot-password answered differently for real and unknown users, and
//      a reset request deleted the user's pending invite link.
//  B2  A sent email was marked scanned before its promise extraction ran.
//  B3  Memory import read every failure (spend cap, outage) as "nothing found".
//  B4  An unparseable briefing was cached for 24h as if valid.
//  C1  Decisions were read-modify-written from a stale per-instance cache.
//  C2  patchSettings was an unlocked whole-record write from a stale cache.
//  C3  The AI-projects sync dropped imported projects and overwrote hides made
//      during it; every projects write was unlocked.
//  C6  The 5s lock TTL could expire under a slow queued write.
//  D4  The public health check paid for a Blob round trip on every hit.
//  D5  A failure after paid tokens refunded the whole reservation.
//  D6  A throw while building the chat stream leaked the reservation.
//  +   generate-validated had no timeout: a hung provider held the reservation.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { loadTs, makeLock, nextServer } from "./_helpers/load-ts.mjs";

const require = createRequire(import.meta.url);
const ai = require("ai");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
// Values built inside the sandbox have its own Object/Array, so compare as plain data.
const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const tick = () => new Promise((r) => setImmediate(r));

class SpendCapError extends Error {
  constructor(scope = "user-daily") { super(`AI spend cap reached (${scope})`); this.name = "SpendCapError"; this.scope = scope; this.retryAfterSec = 60; }
}

// ── A6. Google reconnect keeps the working connection when refused ────────────

function googleCallback({ had, address, owners = {}, ownerThrows = false }) {
  const store = { google: had ?? null };
  const calls = { ownerChecks: 0 };
  const NEW = { refresh_token: "new-refresh-fixture" };
  const redirect = (url) => ({ status: 307, location: String(url), cookies: { set() {} } });
  const route = loadTs("app/api/auth/google/callback/route.ts", {
    "next/server": { NextResponse: { redirect }, after: () => {} },
    "@/lib/google/auth": {
      exchangeCode: async () => { store.google = NEW; },
      snapshotGoogleTokens: async () => store.google,
      restoreGoogleTokens: async (_u, t) => { store.google = t; },
    },
    "@/lib/auth": { getSessionUser: async () => "guy" },
    "@/lib/storage/persistent": { forceFlushSnapshot: async () => {} },
    "@/lib/google/register-webhooks": { autoRegisterGoogleWebhooks: async () => ({ gmail: true, calendar: true }) },
    "@/lib/onboarding/backfill": { triggerOnboardingBackfill: async () => {} },
    "@/lib/auth/oauth-state": { verifyOAuthState: () => true, clearOAuthStateCookie: () => ({ name: "st", value: "", options: {} }) },
    "@/lib/google/gmail": { getGmailAddress: async () => address },
    "@/lib/self-identity": { rememberOwnAddress: async () => false },
    "@/lib/google/account-owner": { otherOwnerOf: async (a) => { calls.ownerChecks++; if (ownerThrows) throw new Error("users store down"); return owners[a] ?? null; } },
    "@/lib/storage/secure-token-store": { deleteIntegrationToken: async () => { store.google = null; } },
  });
  const get = () => route.GET(new Request("https://basil.test/api/auth/google/callback?code=c1&state=s1"));
  return { get, store, calls, NEW };
}
const OLD = { refresh_token: "old-refresh-fixture" };

test("A6. picking an account another user owns keeps the connection you had", async () => {
  const g = googleCallback({ had: OLD, address: "michael@talentgenius.io", owners: { "michael@talentgenius.io": "michael" } });
  const res = await g.get();
  assert.match(res.location, /error=google_taken/);
  assert.equal(JSON.stringify(g.store.google), JSON.stringify(OLD), "the previous working tokens are back");
});

test("A6. with no previous connection, a refused account leaves you disconnected (as before)", async () => {
  const g = googleCallback({ had: null, address: "michael@talentgenius.io", owners: { "michael@talentgenius.io": "michael" } });
  await g.get();
  assert.equal(g.store.google, null);
});

test("A6. a failed address lookup is a failure: the unverified tokens are discarded, not kept", async () => {
  const g = googleCallback({ had: OLD, address: null });
  const res = await g.get();
  assert.match(res.location, /error=oauth_failed/);
  assert.equal(g.calls.ownerChecks, 0, "nothing to check ownership of");
  assert.equal(JSON.stringify(g.store.google), JSON.stringify(OLD));
});

test("A6. a throw during verification restores the previous connection; your own account connects", async () => {
  const thrown = googleCallback({ had: OLD, address: "guy@talentgenius.io", ownerThrows: true });
  assert.match((await thrown.get()).location, /error=oauth_failed/);
  assert.equal(JSON.stringify(thrown.store.google), JSON.stringify(OLD));
  const own = googleCallback({ had: OLD, address: "guy@talentgenius.io" });
  assert.match((await own.get()).location, /connected=google/);
  assert.equal(JSON.stringify(own.store.google), JSON.stringify(own.NEW), "your own account replaces the old one");
});

// ── A7 + D5. No cross-provider replay after progress; paid steps committed ────

function generateModule(generateText, settled) {
  return loadTs("lib/ai/generate.ts", {
    ai: { generateText, streamText: () => ({}), stepCountIs: ai.stepCountIs },
    "@/lib/ai/model-config": { getTextModel: () => "primary", getDirectAnthropicModel: () => "anthropic-fallback", getDirectOpenAIModel: () => null, preferOpenAI: () => false, PROVIDER_MODE: "openai_direct" },
    "@/lib/ai/spend-guard": {
      reserveSpend: async () => ({ username: "f", feature: "t", family: "opus5", reservedUsd: 0, heldKeys: [] }),
      commitSpend: async (_r, u) => { settled.push(["commit", plain(u)]); },
      releaseSpend: async () => { settled.push(["release"]); },
    },
    "@/lib/ai/pricing": { costUsd: () => 0 },
  });
}
const METER = { username: "f", feature: "chat:mobile" };

test("A7. a loop that fails after an approved tool ran is NOT replayed on the fallback provider", async () => {
  const settled = []; const models = [];
  const G = generateModule(async (opts) => {
    models.push(opts.model);
    await opts.experimental_onToolCallStart?.({ toolCall: { toolName: "sendEmail" } }); // the approved send runs
    throw new Error("timeout while generating the next step");
  }, settled);
  await assert.rejects(G.generateTextSafe({ prompt: "x" }, "default", METER), (e) => e.afterProgress === true && /not retried on another provider/.test(e.message));
  assert.deepEqual(plain(models), ["primary"], "one attempt: the email goes out once");
  assert.deepEqual(plain(settled), [["release"]], "no completed step, no known usage: refunded");
});

test("A7/D5. a loop that fails after a completed step commits that step's usage instead of refunding", async () => {
  const settled = []; const models = [];
  const G = generateModule(async (opts) => {
    models.push(opts.model);
    await opts.onStepFinish({ usage: { inputTokens: 1000, outputTokens: 200 } });
    throw new Error("provider 502 on step 2");
  }, settled);
  await assert.rejects(G.generateTextSafe({ prompt: "x" }, "default", METER), /failed after 1 completed step/);
  assert.deepEqual(plain(models), ["primary"]);
  assert.equal(settled.length, 1);
  assert.equal(settled[0][0], "commit");
  assert.equal(settled[0][1].inputTokens, 1000);
  assert.equal(settled[0][1].outputTokens, 200);
});

test("A7. a failure before anything ran still falls back to the other provider; the caller's callbacks still fire", async () => {
  const settled = []; const models = []; const seen = [];
  const G = generateModule(async (opts) => {
    models.push(opts.model);
    if (opts.model === "primary") throw new Error("429 rate limit");
    await opts.onStepFinish({ usage: { inputTokens: 5, outputTokens: 5 } });
    return { text: "ok", usage: { inputTokens: 5, outputTokens: 5 }, totalUsage: { inputTokens: 5, outputTokens: 5 } };
  }, settled);
  const r = await G.generateTextSafe({ prompt: "x", onStepFinish: (s) => seen.push(s.usage.inputTokens) }, "default", METER);
  assert.equal(r.text, "ok");
  assert.deepEqual(plain(models), ["primary", "anthropic-fallback"]);
  assert.deepEqual(seen, [5], "the caller's onStepFinish is kept");
  assert.equal(settled[0][0], "commit");
});

test("A7. a caller's attemptTimeoutMs replaces the tier ceiling", async () => {
  const G = generateModule((opts) => new Promise((_res, rej) => opts.abortSignal.addEventListener("abort", () => rej(new Error("timeout")))), []);
  const t0 = Date.now();
  await assert.rejects(G.generateTextSafe({ prompt: "x" }, "default", METER, { attemptTimeoutMs: 20 }));
  assert.ok(Date.now() - t0 < 2_000, "two 20ms attempts, not two 55s ones");
});

function mobileRoute(generateTextSafe) {
  return loadTs("app/api/chat/mobile/route.ts", {
    "@/lib/trust/ledger": { getDelegations: async () => new Set(), recordApprovalResponses: async () => 0, recordDelegatedRuns: async () => 0 },
    ai,
    "@/lib/ai/generate": { generateTextSafe },
    "@/lib/ai/repair-history": loadTs("lib/ai/repair-history.ts"),
    "@/lib/ai/injection-guard": loadTs("lib/ai/injection-guard.ts"),
    "@/lib/ai/spend-guard": { SpendCapError, spendCapResponse: () => new Response("cap", { status: 429 }) },
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
const mobilePost = (route) => route.POST(new Request("http://fixture.invalid/api/chat/mobile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "Email Jane the deck" }] }) }));

test("A7. mobile chat sizes its attempt ceiling to its 300s route budget, and says so when a reply fails after an action", async () => {
  let safe;
  const ok = mobileRoute(async (_o, _k, _m, s) => { safe = s; return { text: "Done.", content: [], steps: [] }; });
  assert.equal((await mobilePost(ok)).status, 200);
  assert.ok(safe.attemptTimeoutMs > 55_000 && safe.attemptTimeoutMs <= 142_500, `ceiling ${safe.attemptTimeoutMs}ms: two attempts fit in 300s less a margin`);

  const partial = mobileRoute(async () => { throw Object.assign(new Error("failed after 1 completed step"), { afterProgress: true }); });
  const res = await mobilePost(partial);
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.partial, true);
  assert.match(body.error, /may already have run/);
});

// ── D5 + D6. Chat route settles the hold on every path ────────────────────────

function chatRoute({ streamText, buildTools = () => ({}) }) {
  const settled = [];
  const route = loadTs("app/api/chat/route.ts", {
    "@/lib/ai/injection-guard": loadTs("lib/ai/injection-guard.ts"),
    "@/lib/trust/ledger": { getDelegations: async () => new Set(), recordApprovalResponses: async () => 0, recordDelegatedRuns: async () => 0 },
    ai: { ...ai, streamText },
    "@/lib/ai/model-config": { getChatModel: () => "mock-model", MAX_TOKENS: { default: 1 }, PROVIDER_MODE: "openai_direct" },
    "@/lib/ai/system-prompt": { getChatPromptParts: async () => ({ instructions: "sys", turnContext: "ctx" }) },
    "@/lib/ai/prompt-cache": loadTs("lib/ai/prompt-cache.ts"),
    "@/lib/ai/tools": { buildAssistantTools: buildTools },
    "@/lib/auth": { getSessionUser: async () => "fixture" },
    "@/lib/settings/store": { getSettings: async () => ({ name: "Fixture User" }) },
    "@/lib/timezone": { resolveTimezone: () => "Europe/London" },
    "@/lib/rate-limit": { checkRateLimitDurable: async () => ({ allowed: true }), getClientIp: () => "203.0.113.1" },
    "@/lib/ai/repair-history": loadTs("lib/ai/repair-history.ts"),
    "@/lib/ai/spend-guard": {
      reserveSpend: async () => ({ username: "fixture", feature: "chat", family: "opus5", reservedUsd: 0.27, heldKeys: ["k"] }),
      commitSpend: async (_r, u) => { settled.push(["commit", plain(u)]); },
      releaseSpend: async () => { settled.push(["release"]); },
      SpendCapError, spendCapResponse: () => new Response("cap", { status: 429 }),
    },
    "@/lib/billing/entitlement-store": { getEntitlement: async () => ({ plan: "pro", aiMonthlyUsd: 10 }) },
    "@/lib/ai/tiering": { effectiveKind: () => "default" },
    "@/lib/ai/pricing": { CHAT_PRICE_FAMILY: "opus5", costUsd: () => 0 },
  });
  return { route, settled };
}
const chatPost = (route) => route.POST(new Request("http://fixture.invalid/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }] }) }));
const fakeStream = (capture) => (args) => { capture.args = args; return { toUIMessageStreamResponse: () => new Response("ok"), consumeStream: async () => {} }; };

test("D6. a throw while building the tools or the stream returns the hold", async () => {
  const tools = chatRoute({ streamText: fakeStream({}), buildTools: () => { throw new Error("tool registry broke"); } });
  await assert.rejects(chatPost(tools.route), /tool registry broke/);
  assert.deepEqual(plain(tools.settled), [["release"]]);
  const stream = chatRoute({ streamText: () => { throw new Error("bad model id"); } });
  await assert.rejects(chatPost(stream.route), /bad model id/);
  assert.deepEqual(plain(stream.settled), [["release"]]);
});

test("D5. a stream error after a paid step commits that step; one before any step refunds", async () => {
  const cap = {};
  const paid = chatRoute({ streamText: fakeStream(cap) });
  assert.equal((await chatPost(paid.route)).status, 200);
  cap.args.onStepFinish({ usage: { inputTokens: 4000, outputTokens: 300 } });
  cap.args.onError({ error: new Error("stream reset") });
  await tick();
  assert.equal(paid.settled.length, 1);
  assert.equal(paid.settled[0][0], "commit");
  assert.equal(paid.settled[0][1].inputTokens, 4000);

  const cap2 = {};
  const none = chatRoute({ streamText: fakeStream(cap2) });
  await chatPost(none.route);
  cap2.args.onError({ error: new Error("401") });
  cap2.args.onError({ error: new Error("again") }); // settles once
  await tick();
  assert.deepEqual(plain(none.settled), [["release"]]);
});

// ── D5 + timeout. generate-validated ──────────────────────────────────────────

function validated(generateText, settled, timeoutMs = 50) {
  return loadTs("lib/ai/generate-validated.ts", {
    ai: { generateText, Output: { object: () => ({}), array: () => ({}) }, NoObjectGeneratedError: { isInstance: (e) => e?.noObject === true } },
    zod: require("zod"),
    "@/lib/ai/spend-guard": {
      reserveSpend: async () => ({ reservedUsd: 0.1, heldKeys: ["k"] }),
      commitSpend: async (_r, u) => { settled.push(["commit", plain(u)]); },
      releaseSpend: async () => { settled.push(["release"]); },
      SpendCapError,
    },
    "@/lib/ai/generate": { attemptTimeoutMs: () => timeoutMs },
  });
}
const vOpts = { kind: "object", schema: {}, schemaName: "S", model: "m", maxOutputTokens: 1, system: "s", prompt: "p", tag: "t", meter: { username: "f", feature: "t" } };

test("D5. a schema-invalid answer is paid for: its usage is committed on both attempts, not refunded", async () => {
  const settled = [];
  const V = validated(async () => { throw Object.assign(new Error("No object generated"), { noObject: true, text: "{", usage: { inputTokens: 800, outputTokens: 90 } }); }, settled);
  await assert.rejects(V.generateValidated(vOpts), (e) => e.name === "AIValidationError");
  assert.deepEqual(settled.map((s) => s[0]), ["commit", "commit"]);
  assert.equal(settled[0][1].inputTokens, 800);
});

test("generate-validated: each attempt has a timeout, so a hung provider gives the hold back", async () => {
  const settled = [];
  const V = validated((opts) => new Promise((_res, rej) => opts.abortSignal.addEventListener("abort", () => rej(new Error("The operation was aborted due to timeout")))), settled, 20);
  const t0 = Date.now();
  await assert.rejects(V.generateValidated(vOpts), /aborted due to timeout/);
  assert.ok(Date.now() - t0 < 2_000);
  assert.deepEqual(plain(settled), [["release"], ["release"]], "no usage known: refunded");
});

// ── A10. Account deletion: provider revoke, then an awaited purge ─────────────

test("A10. admin delete revokes the provider grants, then waits for the purge before replying", async () => {
  const order = [];
  const route = loadTs("app/api/admin/users/[id]/route.ts", {
    "next/server": nextServer,
    "@/lib/auth": { getSessionUser: async () => "michael" },
    "@/lib/users": { getUsers: async () => [{ id: "u2", username: "ed.baum" }], isAdminUser: (u) => u === "michael", setUserDisabled: async () => {}, setUserAiDailyLimit: async () => {}, deleteUser: async () => { order.push("deleteUser"); }, revokeUserSessions: async () => {} },
    "@/lib/storage/persistent": { purgeUserData: async (u) => { await tick(); await tick(); order.push(`purge:${u}`); return { deleted: 12 }; } },
    "@/lib/auth/siri-tokens": { revokeSiriToken: async () => { order.push("siri"); } },
    "@/lib/auth/revoke-integrations": { revokeIntegrationTokens: async (u) => { order.push(`revoke:${u}`); return { google: "revoked", slack: "none" }; } },
    "@/lib/billing/entitlement-store": { activatePlan: async () => {}, cancelPlan: async () => {} },
  });
  const res = await route.DELETE({}, { params: Promise.resolve({ id: "u2" }) });
  order.push("responded");
  assert.equal(res.status, 200);
  assert.deepEqual(order, ["deleteUser", "siri", "revoke:ed.baum", "purge:ed.baum", "responded"]);
});

test("A10. deleting your own account does the same, and a failing purge is still non-fatal", async () => {
  const order = [];
  const route = loadTs("app/api/profile/route.ts", {
    "next/server": nextServer,
    path: require("node:path"), "fs/promises": require("node:fs/promises"),
    "@/lib/auth": { getSessionUser: async () => "alice" },
    "@/lib/users": { deleteUser: async () => { order.push("deleteUser"); }, isAdminUser: () => false, findByUsername: async () => null },
    "@/lib/storage/persistent": { forceFlushSnapshot: async () => {}, purgeUserData: async () => { await tick(); order.push("purge"); throw new Error("blob down"); } },
    "@/lib/auth/siri-tokens": { revokeSiriToken: async () => {} },
    "@/lib/auth/revoke-integrations": { revokeIntegrationTokens: async () => { order.push("revoke"); return { google: "none", slack: "revoked" }; } },
  });
  const res = await route.DELETE();
  order.push("responded");
  assert.equal(res.status, 200);
  assert.deepEqual(order, ["deleteUser", "revoke", "purge", "responded"]);
});

function revoker(stored, fetchImpl) {
  const calls = [];
  const R = loadTs("lib/auth/revoke-integrations.ts", {
    "@/lib/storage/secure-token-store": { getIntegrationToken: async (u, p) => stored[`${u}/${p}`] ?? null },
  }, {}, { fetch: async (url, init) => { calls.push({ url, init }); return fetchImpl(url, init); } });
  return { R, calls };
}

test("A10. revoke: Google's refresh token and Slack's USER token (never the shared bot token); failures are swallowed", async () => {
  const stored = { "ed/google": { refresh_token: "google-refresh-fixture", access_token: "a" }, "ed/slack": { userToken: "slack-user-fixture", botToken: "slack-bot-fixture" } };
  const { R, calls } = revoker(stored, async (url) => (url.includes("slack") ? Response.json({ ok: true, revoked: true }) : new Response("", { status: 200 })));
  assert.deepEqual(plain(await R.revokeIntegrationTokens("ed")), { google: "revoked", slack: "revoked" });
  const google = calls.find((c) => c.url === "https://oauth2.googleapis.com/revoke");
  assert.equal(google.init.method, "POST");
  assert.equal(google.init.body, "token=google-refresh-fixture");
  const slack = calls.find((c) => c.url === "https://slack.com/api/auth.revoke");
  assert.equal(slack.init.headers.Authorization, "Bearer slack-user-fixture");
  assert.ok(!JSON.stringify(calls).includes("slack-bot-fixture"), "the workspace bot token is left alone");

  const down = revoker(stored, async () => { throw new Error("network down"); });
  assert.deepEqual(plain(await down.R.revokeIntegrationTokens("ed")), { google: "failed", slack: "failed" });
  const nothing = revoker({}, async () => { throw new Error("must not be called"); });
  assert.deepEqual(plain(await nothing.R.revokeIntegrationTokens("ed")), { google: "none", slack: "none" });
  assert.equal(nothing.calls.length, 0);
});

// ── A11. forgot-password: one answer for everyone; invites survive ────────────

function forgotRoute({ users = {}, createFails = false } = {}) {
  const queued = []; const issued = []; const sent = [];
  const route = loadTs("app/api/auth/forgot-password/route.ts", {
    "next/server": { NextResponse: nextServer.NextResponse, after: (fn) => queued.push(fn) },
    "@/lib/email/send": { sendEmail: async (m) => { sent.push(m.to); return { ok: true }; }, isEmailConfigured: () => true, resendKeyProblem: () => null },
    "@/lib/users": { findByEmail: async (e) => Object.values(users).find((u) => u.email === e) ?? null, findByUsername: async (n) => users[n] ?? null },
    "@/lib/auth/reset-tokens": { createResetToken: async (u) => { if (createFails) throw new Error("store down"); issued.push(u); return "tok"; } },
    "@/lib/rate-limit": { checkRateLimitDurable: async () => ({ allowed: true }), getClientIp: () => "203.0.113.9" },
    "@/lib/storage/persistent": { forceFlushSnapshot: async () => {} },
  }, { NODE_ENV: "test", NEXT_PUBLIC_APP_URL: "https://basil.test" });
  const post = (body) => route.POST(new Request("https://basil.test/api/auth/forgot-password", { method: "POST", body: JSON.stringify(body) }));
  return { post, queued, issued, sent };
}

test("A11. real and unknown accounts get the identical reply; the link is issued after it", async () => {
  const f = forgotRoute({ users: { ed: { username: "ed", email: "ed@x.test", name: "Ed" } } });
  const unknown = await f.post({ username: "nobody" });
  const real = await f.post({ username: "ed" });
  assert.deepEqual(plain(unknown.body), { ok: true });
  assert.deepEqual(plain(real.body), { ok: true });
  assert.equal(unknown.status, real.status);
  assert.equal(f.queued.length, 1, "only the real account has work queued");
  for (const fn of f.queued) await fn();
  assert.deepEqual(f.issued, ["ed"]);
  assert.deepEqual(f.sent, ["ed@x.test"]);
  const broken = forgotRoute({ users: { ed: { username: "ed", email: "ed@x.test", name: "Ed" } }, createFails: true });
  const res = await broken.post({ username: "ed" });
  assert.deepEqual(plain(res.body), { ok: true }, "a storage failure is not an oracle either");
  for (const fn of broken.queued) await fn(); // logs, does not throw
});

function tokenStore(initial = []) {
  let rows = initial;
  const T = loadTs("lib/auth/reset-tokens.ts", {
    "@/lib/storage/lock": makeLock(),
    "@/lib/storage/secure-auth-store": {
      hashResetToken: (s) => `h:${s}`,
      readResetTokenRecords: async () => JSON.parse(JSON.stringify(rows)),
      writeResetTokenRecords: async (r) => { rows = JSON.parse(JSON.stringify(r)); },
    },
  });
  return { T, rows: () => rows };
}
const DAY = 24 * 60 * 60 * 1000;

test("A11. a reset request keeps the user's live invite link; a newer reset replaces the older reset", async () => {
  const s = tokenStore();
  const invite = await s.T.createResetToken("ed", "ed@x.test", 7 * DAY);
  const reset1 = await s.T.createResetToken("ed", "ed@x.test");
  assert.equal(await s.T.validateResetToken(invite), "ed", "the invite still works after someone asks for a reset");
  assert.equal(await s.T.validateResetToken(reset1), "ed");
  const reset2 = await s.T.createResetToken("ed", "ed@x.test");
  assert.equal(await s.T.validateResetToken(reset1), null, "the older reset link is replaced");
  assert.equal(await s.T.validateResetToken(reset2), "ed");
  assert.equal(await s.T.validateResetToken(invite), "ed");
  await s.T.createResetToken("ed", "ed@x.test", 7 * DAY);
  assert.equal(await s.T.validateResetToken(invite), null, "a new invite replaces everything");
  assert.equal(await s.T.validateResetToken(reset2), null);
});

test("A11. an invite written before token kinds existed is recognised by its lifetime", async () => {
  const legacy = { tokenHash: "h:legacy", username: "ed", email: "ed@x.test", expiresAt: new Date(Date.now() + 5 * DAY).toISOString(), used: false };
  const s = tokenStore([legacy]);
  await s.T.createResetToken("ed", "ed@x.test");
  assert.equal(await s.T.validateResetToken("legacy"), "ed");
});

// ── B2. Promise capture marks a message only once it is read to a verdict ─────

function capture(extract) {
  let state = { processed: [] };
  const created = [];
  const C = loadTs("lib/commitments/capture.ts", {
    zod: require("zod"),
    "@/lib/google/gmail": {},
    "@/lib/actions/store": { createActionTracked: async (_u, a) => { created.push(a.sourceRef); return { created: true }; } },
    "@/lib/storage/user-store": {
      readUserStore: async () => JSON.parse(JSON.stringify(state)),
      updateUserStore: async (_u, _f, fn) => { state = fn(state); return state; },
    },
    "@/lib/settings/store": { getSettings: async () => ({ name: "Fixture Owner" }) },
    "@/lib/ai/system-prompt": { getTaskSystemPrompt: async () => "" },
    "@/lib/ai/generate": {}, "@/lib/ai/model-config": {},
    "@/lib/ai/spend-guard": { SpendCapError },
    "@/lib/ai/parse-json": loadTs("lib/ai/parse-json.ts", { zod: require("zod") }),
    "@/lib/email/triage": loadTs("lib/email/triage.ts"),
    "@/lib/security/sensitive": { redactSensitive: (s) => ({ text: s }) },
  });
  const sent = [
    { id: "m1", to: "jane@x.test", subject: "Deck", date: "2026-11-09T10:00:00Z" },
    { id: "m2", to: "ed@x.test", subject: "Pricing", date: "2026-11-09T11:00:00Z" },
    { id: "m3", to: "ed@x.test", subject: "Thanks", date: "2026-11-09T12:00:00Z" },
  ];
  const bodies = { m1: "I'll send the deck by Friday.", m2: "I will get back to you on pricing.", m3: "Thanks, great call." };
  const deps = { now: Date.parse("2026-11-10T09:00:00Z"), sent: async () => sent, body: async (_u, id) => bodies[id], extract };
  const ok = JSON.stringify({ commitments: [{ text: "Do the thing", to: "X", dueDate: null, quote: "I'll" }] });
  return { run: () => C.captureSentPromises("u", { force: true }, deps), state: () => state, created, ok };
}

test("B2. a failed or unparseable extraction leaves the email unmarked, so the next scan retries it", async () => {
  let fail = true;
  const c = capture(async (prompt) => {
    if (/Deck/.test(prompt) && fail) throw new Error("provider 503");
    if (/Pricing/.test(prompt) && fail) return "not json at all";
    return c.ok;
  });
  const first = await c.run();
  assert.equal(first.failed, 2);
  assert.deepEqual(plain(c.state().processed.sort()), ["m3"], "only the deliberate skip (no promise wording) is recorded");
  fail = false;
  const second = await c.run();
  assert.equal(second.created, 2, "both promises are found on the retry");
  assert.deepEqual(plain(c.state().processed.sort()), ["m1", "m2", "m3"]);
});

test("B2. the spend cap stops the scan; nothing it did not read is marked", async () => {
  let calls = 0;
  const c = capture(async () => { calls++; throw new SpendCapError(); });
  const out = await c.run();
  assert.equal(out.stopped, "spend-cap");
  assert.equal(calls, 1, "no further model calls once the cap is hit");
  assert.deepEqual(plain(c.state().processed), []);
});

// ── B3. Memory import: failures are not "nothing found" ───────────────────────

function memoryImport(generateTextSafe, globals = {}) {
  const saved = [];
  const route = loadTs("app/api/memory/import/route.ts", {
    "next/server": nextServer,
    "@/lib/ai/model-config": { getTextModel: () => "m", MAX_TOKENS: { default: 1 }, PROVIDER_MODE: "openai_direct" },
    "@/lib/ai/generate": { generateTextSafe },
    "@/lib/ai/spend-guard": { SpendCapError, spendCapResponse: (e) => ({ status: 429, body: { code: "spend_cap", scope: e.scope } }) },
    "@/lib/ai/parse-json": { parseAndValidate: (t) => { try { return { ok: true, data: JSON.parse(t) }; } catch { return { ok: false, error: "not JSON" }; } } },
    "@/lib/ai/schemas": { MemoryImportArraySchema: {} },
    "@/lib/auth": { getSessionUser: async () => "u" },
    "@/lib/memory/store": { createMemory: async (_u, m) => { saved.push(m.content); return { id: `m${saved.length}`, ...m }; } },
    "@/lib/storage/persistent": { forceFlushSnapshot: async () => {} },
  }, {}, globals);
  const post = (text) => route.POST(new Request("https://basil.test/api/memory/import", { method: "POST", body: JSON.stringify({ text }) }));
  return { post, saved };
}
const ONE = JSON.stringify([{ kind: "preference", content: "The user prefers bullet-point summaries" }]);
const BIG = "x".repeat(80_000); // three chunks

test("B3. the spend cap is a 429 and an outage is an error — not '0 imported'", async () => {
  const cap = memoryImport(async () => { throw new SpendCapError("user-daily"); });
  const capped = await cap.post("Some notes about me and how I like to work.");
  assert.equal(capped.status, 429);
  const down = memoryImport(async () => { throw new Error("provider 503"); });
  const failed = await down.post("Some notes about me and how I like to work.");
  assert.equal(failed.status, 502);
  assert.match(failed.body.error, /Nothing was imported/);
  const empty = memoryImport(async () => ({ text: "[]" }));
  assert.deepEqual(plain((await empty.post("Some notes about a competitor's dashboard.")).body), { imported: 0, memories: [] }, "a real empty answer is still 0 imported");
});

test("B3. a chunk that fails mid-document keeps what was extracted and says partial", async () => {
  let n = 0;
  const m = memoryImport(async () => { n++; if (n === 2) throw new Error("timeout"); return { text: n === 1 ? ONE : "[]" }; });
  const res = await m.post(BIG);
  assert.equal(res.status, 200);
  assert.equal(res.body.imported, 1);
  assert.equal(res.body.partial, true);
  assert.equal(res.body.failedChunks, 1);
  assert.equal(res.body.totalChunks, 3);
});

test("B3. chunking stops at the time budget and saves what it has", async () => {
  let now = Date.parse("2026-11-10T09:00:00Z");
  class FakeDate extends Date { static now() { return now; } }
  let calls = 0;
  const m = memoryImport(async () => { calls++; now += 250_000; return { text: ONE }; }, { Date: FakeDate });
  const res = await m.post(BIG);
  assert.equal(calls, 1, "the 240s budget is spent after the first chunk");
  assert.equal(res.body.imported, 1);
  assert.equal(res.body.partial, true);
  assert.equal(res.body.unreadChunks, 2);
});

// ── B4. An unparseable briefing is returned, marked, and never cached ─────────

test("B4. the briefing cache write runs only when the answer parsed; the raw text is marked unparsed", () => {
  const r = src("app/api/generate/briefing/route.ts");
  const tail = r.slice(r.indexOf('const parseResult = parseAndValidate(result.text, BriefingOutputSchema, "[briefing]");'));
  assert.ok(tail.length > 0);
  assert.match(tail, /criticalToday: redactSensitive\(result\.text\)\.text,\s*unparsed: true,/);
  const guard = tail.indexOf("if (parseResult.ok) {\n    try {");
  const write = tail.indexOf("await writeGenerateCache(");
  assert.ok(guard > 0 && write > guard, "writeGenerateCache sits inside the parse-ok branch");
  assert.equal(tail.split("writeGenerateCache(").length, 2, "and nowhere else after the parse");
  assert.match(src("lib/types/briefing.ts"), /unparsed\?: true;/);
});

// ── C1. Decisions: every locked read-modify-write reads fresh ─────────────────

function decisionsInstance(durable) {
  let cache;
  return loadTs("lib/decisions/store.ts", {
    "@/lib/events/lock": durable.lock,
    "@/lib/storage/user-store": {
      readUserStore: async (_u, _f, fb, opts) => {
        if (cache === undefined || opts?.fresh) cache = JSON.parse(JSON.stringify(durable.rows ?? fb));
        return JSON.parse(JSON.stringify(cache));
      },
      writeUserStore: async (_u, _f, d) => { durable.rows = JSON.parse(JSON.stringify(d)); cache = JSON.parse(JSON.stringify(d)); },
    },
  });
}

test("C1. an edit on a stale instance no longer erases a decision another instance just made", async () => {
  const durable = { rows: [], lock: makeLock() };
  const a = decisionsInstance(durable), b = decisionsInstance(durable);
  const first = await a.createDecision("u", { text: "Ship the pilot in December", decidedBy: "Michael" });
  await a.listDecisions("u"); // A's cache now holds one decision
  await b.createDecision("u", { text: "Hire a second engineer for the platform team", decidedBy: "Michael" });
  await a.updateDecision("u", first.id, { status: "superseded" }); // A edits from its (stale) cache
  assert.equal(durable.rows.length, 2, "B's decision survives A's edit");
  await b.deleteDecision("u", first.id);
  await a.linkActionToDecision("u", durable.rows[0].id, "act-1");
  assert.equal(durable.rows.length, 1, "the deleted decision is not brought back");
  assert.equal(JSON.stringify(durable.rows[0].linkedActionIds), JSON.stringify(["act-1"]));
});

// ── C2. Settings: locked, fresh, validated before the write ───────────────────

function settingsInstance(durable) {
  let cache;
  const lock = durable.lock;
  return loadTs("lib/settings/store.ts", {
    "@/lib/away/calendar": { HOLIDAY_REGIONS: ["england-and-wales", "scotland", "northern-ireland"] },
    "@/lib/storage/user-store": {
      readUserStore: async (_u, _f, fb) => { if (cache === undefined) cache = JSON.parse(JSON.stringify(durable.rows ?? fb)); return JSON.parse(JSON.stringify(cache)); },
      updateUserStore: (_u, _f, fn, fb) => lock.withLock("settings", async () => {
        const next = fn(JSON.parse(JSON.stringify(durable.rows ?? fb))); // a fresh read under the lock
        durable.rows = JSON.parse(JSON.stringify(next)); cache = JSON.parse(JSON.stringify(next));
        durable.writes++;
        return next;
      }),
    },
  });
}

test("C2. saving one setting no longer reverts another changed on a different instance", async () => {
  const durable = { rows: undefined, lock: makeLock(), writes: 0 };
  const a = settingsInstance(durable), b = settingsInstance(durable);
  await a.getSettings("michael"); // A caches the defaults
  await b.patchSettings("michael", { timezone: "America/New_York" });
  const out = await a.patchSettings("michael", { name: "Michael Cook" });
  assert.equal(out.timezone, "America/New_York");
  assert.equal(out.name, "Michael Cook");
  assert.equal(durable.rows.timezone, "America/New_York");
});

test("C2. every validation still runs before anything is written", async () => {
  const durable = { rows: undefined, lock: makeLock(), writes: 0 };
  const s = settingsInstance(durable);
  await assert.rejects(s.patchSettings("michael", { timezone: "Mars/Olympus" }), /Invalid timezone/);
  await assert.rejects(s.patchSettings("michael", { workStart: "9am" }), /Invalid workStart/);
  await assert.rejects(s.patchSettings("michael", { workingDays: [] }), /at least one day/);
  await assert.rejects(s.patchSettings("michael", { holidayRegion: "wales" }), /Invalid holidayRegion/);
  assert.equal(durable.writes, 0);
  const ok = await s.patchSettings("michael", { workingDays: [5, 1, 1] });
  assert.equal(JSON.stringify(ok.workingDays), JSON.stringify([1, 5]));
});

// ── C3. AI projects: imports survive the sync; hides during it survive too ────

function projectsFixture(initial) {
  const durable = { data: initial, writes: 0 };
  const lock = makeLock();
  const userStore = {
    readUserStore: async (_u, _f, fb) => JSON.parse(JSON.stringify(durable.data ?? fb)),
    writeUserStore: async () => { throw new Error("unlocked whole-file write"); },
    updateUserStore: (_u, _f, fn, fb) => lock.withLock("ai-projects", async () => {
      const next = fn(JSON.parse(JSON.stringify(durable.data ?? fb)));
      durable.data = JSON.parse(JSON.stringify(next));
      durable.writes++;
      return next;
    }),
  };
  const store = loadTs("lib/ai-projects/store.ts", { "@/lib/storage/user-store": userStore, "./types": loadTs("lib/ai-projects/types.ts") });
  return { durable, store };
}
const proj = (platform, id, extra = {}) => ({ id: `${platform}:${id}`, platform, externalId: id, name: `${platform} ${id}`, createdAt: "2026-11-01", lastActiveAt: "2026-11-01", category: "work", importance: "medium", summary: "", hidden: false, syncedAt: "2026-11-01", ...extra });

test("C3. the sync keeps imported projects and platforms whose fetch came back empty, and a hide made during the fetch", async () => {
  const fx = projectsFixture({
    projects: [proj("chatgpt", "c1"), proj("github", "repo-a"), proj("github", "repo-b"), proj("linear", "l1")],
    platforms: { chatgpt: { platform: "chatgpt", label: "ChatGPT", connected: true, scraped: true, itemCount: 1 } },
  });
  const sync = loadTs("lib/ai-projects/sync.ts", {
    "./store": fx.store,
    "./platforms/claude-code": { fetchClaudeCodeProjects: async () => [] },
    "./platforms/github": {
      fetchGithubProjects: async () => {
        // While the fetch runs, the user hides repo-a.
        await fx.store.updateProjectsStore("u", (d) => ({ ...d, projects: d.projects.map((p) => (p.id === "github:repo-a" ? { ...p, hidden: true } : p)) }));
        return [proj("github", "repo-a", { name: "repo-a (renamed upstream)" }), proj("github", "repo-c")];
      },
    },
    "./platforms/vercel": { fetchVercelProjects: async () => [] },
    "./platforms/linear": { fetchLinearProjects: async () => [] },
    "./platforms/openai": { fetchOpenAIProjects: async () => [] },
    "./platforms/perplexity": { fetchPerplexityProjects: async () => [] },
    "./platforms/grok": { fetchGrokProjects: async () => [] },
    "@/lib/linear/client": { isLinearConnected: async () => true },
    "@/lib/ai-platforms/credentials": { getAIPlatformKey: async (_u, p) => (p === "github" ? "gh-key-fixture" : null) },
    "@/lib/auth/env-credential-owner": { isEnvCredentialOwner: () => false },
  });
  await sync.syncProjects("u");
  const ids = fx.durable.data.projects.map((p) => p.id).sort();
  assert.deepEqual(plain(ids), ["chatgpt:c1", "github:repo-a", "github:repo-c", "linear:l1"],
    "the ChatGPT import and Linear's (empty-fetch) projects are carried over; GitHub is replaced by its fresh list");
  const a = fx.durable.data.projects.find((p) => p.id === "github:repo-a");
  assert.equal(a.hidden, true, "the hide made during the sync is kept");
  assert.equal(a.name, "repo-a (renamed upstream)");
  assert.equal(fx.durable.data.platforms.chatgpt.scraped, true);
});

test("C3. hiding a project is a locked update; an unknown id is a 404 with nothing written", async () => {
  const fx = projectsFixture({ projects: [proj("github", "repo-a")], platforms: {} });
  const route = loadTs("app/api/ai-projects/[id]/route.ts", {
    "next/server": nextServer,
    "@/lib/auth": { getSessionUser: async () => "u" },
    "@/lib/ai-projects/store": fx.store,
  });
  const patch = (id, body) => route.PATCH({ json: async () => body }, { params: Promise.resolve({ id }) });
  assert.equal((await patch("github%3Anope", { hidden: true })).status, 404);
  assert.equal(fx.durable.writes, 0);
  const ok = await patch("github%3Arepo-a", { hidden: true });
  assert.equal(ok.status, 200);
  assert.equal(fx.durable.data.projects[0].hidden, true);
});

test("C3. import and upload write through the locked update, keeping other platforms", async () => {
  const fx = projectsFixture({ projects: [proj("github", "repo-a"), proj("chatgpt", "old")], platforms: {} });
  const route = loadTs("app/api/ai-projects/import/route.ts", {
    "next/server": nextServer,
    "@/lib/auth": { getSessionUser: async () => "u" },
    "@/lib/ai-projects/store": fx.store,
    "@/lib/ai-projects/classifier": { classifyCategory: () => "work", scoreImportance: () => "medium", generateSummary: () => "" },
    "@/lib/ai-projects/types": loadTs("lib/ai-projects/types.ts"),
  });
  const res = await route.POST(new Request("https://basil.test/api/ai-projects/import", { method: "POST", body: JSON.stringify({ platform: "chatgpt", projects: [{ name: "New chat", externalId: "n1" }] }) }));
  assert.equal(res.body.imported, 1);
  assert.deepEqual(plain(fx.durable.data.projects.map((p) => p.id).sort()), ["chatgpt:n1", "github:repo-a"]);
  for (const f of ["app/api/ai-projects/import/route.ts", "app/api/ai-projects/upload/route.ts", "app/api/ai-projects/[id]/route.ts", "lib/ai-projects/sync.ts"]) {
    assert.doesNotMatch(src(f), /writeProjectsStore\(/, `${f} has no unlocked whole-file write`);
  }
});

// ── C6. Lock TTL ──────────────────────────────────────────────────────────────

function lockModule(setImpl) {
  const sets = [];
  const L = loadTs("lib/storage/lock.ts", {
    "@upstash/redis": { Redis: class { set(k, v, o) { sets.push(o); return setImpl(sets.length); } async get() { return null; } async del() {} } },
    "@/lib/storage/redis-config": { resolveRedisRestConfig: () => ({ url: "https://redis.test", token: "fixture" }) },
  });
  return { L, sets };
}

test("C6. the default lock TTL is 30s, and the acquire budget always outlasts the TTL", async () => {
  const { L, sets } = lockModule(async () => "OK");
  assert.equal(await L.withLock("k", async () => "ran"), "ran");
  assert.equal(sets[0].px, 30_000);
  assert.equal(sets[0].nx, true);
  for (const [ttl, wait] of [[30_000, 100], [60_000, 100], [150_000, 500], [400, 1]]) {
    assert.ok(L.defaultRetries(ttl, wait) * wait > ttl, `${ttl}/${wait}`);
  }
  // A caller that raises only the TTL gets a budget that outlasts it: 400ms TTL
  // at 1ms per attempt → more than 320 attempts before giving up.
  const stuck = lockModule(async () => null);
  await assert.rejects(stuck.L.withLock("k", async () => "never", { ttlMs: 400, waitMs: 1 }), /after 420 attempts/);
  assert.equal(stuck.sets.length, 420);
});

// ── D4. Health check: one Blob round trip per minute, however often it is hit ─

test("D4. the public health check reuses one storage round trip instead of paying for one per hit", async () => {
  let puts = 0;
  const route = loadTs("app/api/health/route.ts", {
    "@vercel/blob": { put: async () => { puts++; await tick(); return { url: "https://blob.test/basil/_health" }; }, del: async () => {} },
    "@/lib/storage/adapters/vercel-env": { isVercelEnvAdapterAvailable: () => false, lastPersistError: null, lastPersistOk: null },
  }, { BLOB_READ_WRITE_TOKEN: "fixture", NODE_ENV: "production" }, { fetch: async () => ({ ok: true, status: 200 }) });
  const bodies = await Promise.all([route.GET(), route.GET(), route.GET()].map(async (p) => (await p).json()));
  for (let i = 0; i < 5; i++) bodies.push(await (await route.GET()).json());
  assert.equal(puts, 1, "eight hits, one Blob write");
  assert.ok(bodies.every((b) => b.ok === true && b.checks.storage === "blob-ok"));
  assert.ok(bodies.every((b) => typeof b.checks.storageCheckedAt === "string"));
});
