/**
 * Tier-1 fixes from the 2026-09-15 audit — execution-once and account access.
 *
 * Every case here runs the REAL module (route handler, store, token lib,
 * spend guard) via tests/_helpers/load-ts.mjs, with only storage, network and
 * auth boundaries mocked. None of these assertions would have been possible
 * with the old source-scanning pattern, and every one of them fails on the
 * pre-fix code — that is the whole point.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { loadTs, makeLock, nextServer } from "./_helpers/load-ts.mjs";

const require = createRequire(import.meta.url);
const clone = (v) => structuredClone(v);
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// ═════════════════════════════════════════════════════════════════════════════
// #1 — an approved event executes exactly once
// ═════════════════════════════════════════════════════════════════════════════

function eventsFixture(seedStatus = "pending") {
  const files = new Map();
  const key = (u, f) => `${u}/${f}`;
  files.set(key("fixture", "sage-events.json"), [{
    id: "evt-1", status: seedStatus, source: "email", disposition: "act",
    headline: "Reply to Alice", actionType: "send_email",
    draft: { channel: "email", to: "alice@example.test", body: "fixture" },
    createdAt: "2026-09-15T10:00:00.000Z", updatedAt: "2026-09-15T10:00:00.000Z",
  }]);
  const eventsStore = loadTs("lib/events/store.ts", {
    "./lock": makeLock(),
    "@/lib/storage/user-store": {
      readUserStore: async (u, f, fallback) => clone(files.get(key(u, f)) ?? fallback),
      writeUserStore: async (u, f, items) => { files.set(key(u, f), clone(items)); },
    },
  });
  let executions = 0;
  const route = loadTs("app/api/events/[id]/route.ts", {
    "@/lib/trust/ledger": { recordDecision: async () => true, editDistance: () => 0 },
    "next/server": nextServer,
    "@/lib/auth": { getSessionUser: async () => "fixture" },
    "@/lib/events/store": eventsStore,
    "@/lib/events/executor": {
      executeEvent: async () => { executions += 1; await tick(); return { ok: true, summary: "Mock sent" }; },
    },
    "@/lib/actions/store": { createAction: async () => ({}) },
  });
  const approve = () =>
    route.PATCH({ json: async () => ({ status: "approved" }) }, { params: Promise.resolve({ id: "evt-1" }) });
  const stored = () => files.get(key("fixture", "sage-events.json"))[0];
  return { approve, executions: () => executions, stored };
}

test("#1 a second approval of an executed event replays the receipt — it does not send again", async () => {
  const fx = eventsFixture();
  const first = await fx.approve();
  assert.equal(first.status, 200);
  assert.equal(first.body.event.status, "executed");
  assert.equal(fx.executions(), 1);

  const second = await fx.approve();
  assert.equal(second.status, 200);
  assert.equal(second.body.replayed, true, "replay must be labelled so the UI can say so");
  assert.equal(second.body.event.status, "executed");
  assert.equal(second.body.execution.ok, true);
  assert.equal(fx.executions(), 1, "the executor must not run a second time");
});

test("#1 two simultaneous approvals: one executes, the other is refused while it runs", async () => {
  const fx = eventsFixture();
  const [a, b] = await Promise.all([fx.approve(), fx.approve()]);
  assert.equal(fx.executions(), 1, "exactly one execution across concurrent requests");
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409], `expected one success and one conflict, got ${statuses}`);
  assert.equal(fx.stored().status, "executed");
});

test("#1 a rejected event cannot be executed by approving it afterwards", async () => {
  const fx = eventsFixture("rejected");
  const res = await fx.approve();
  assert.equal(res.status, 200);
  assert.equal(res.body.replayed, true);
  assert.equal(res.body.execution.ok, false);
  assert.equal(fx.executions(), 0);
  assert.equal(fx.stored().status, "rejected", "status must not be disturbed");
});

// ═════════════════════════════════════════════════════════════════════════════
// #3 — a Siri token is only as valid as the account behind it
// ═════════════════════════════════════════════════════════════════════════════

function siriFixture() {
  let rows = [];
  const accounts = new Map([["alice", { id: "u1", username: "alice", disabled: false }]]);
  const tokens = loadTs("lib/auth/siri-tokens.ts", {
    "@/lib/storage/persistent": {
      readStore: async () => clone(rows),
      updateStore: async (_f, fn) => { rows = fn(clone(rows)); return rows; },
    },
    "@/lib/users": { findByUsername: async (u) => clone(accounts.get(u.toLowerCase()) ?? null) },
  });
  const stig = loadTs("lib/stig/auth.ts", {
    "server-only": {},
    "@/lib/auth": { getSessionUser: async () => null },
    "@/lib/auth/siri-tokens": tokens,
  });
  const bearer = (raw) => ({ headers: { get: (n) => (n.toLowerCase() === "authorization" ? `Bearer ${raw}` : null) } });
  return { tokens, stig, accounts, bearer, rows: () => rows };
}

test("#3 disabling an account makes its Siri token stop authenticating; re-enabling restores it", async () => {
  const fx = siriFixture();
  const raw = await fx.tokens.createSiriToken("alice");
  assert.equal(await fx.tokens.verifySiriToken(raw), "alice");

  fx.accounts.get("alice").disabled = true;
  assert.equal(await fx.tokens.verifySiriToken(raw), null, "disabled account must not authenticate");
  assert.equal(await fx.stig.getStigRequestUser(fx.bearer(raw)), null, "Stig must not resolve a disabled account");

  fx.accounts.get("alice").disabled = false;
  assert.equal(await fx.tokens.verifySiriToken(raw), "alice");
});

test("#3 a deleted account's token record no longer authenticates even if it was never revoked", async () => {
  const fx = siriFixture();
  const raw = await fx.tokens.createSiriToken("alice");
  fx.accounts.delete("alice"); // deletion without revocation — the old failure mode
  assert.equal(fx.rows().length, 1, "record deliberately left behind");
  assert.equal(await fx.tokens.verifySiriToken(raw), null);
  assert.equal(await fx.stig.getStigRequestUser(fx.bearer(raw)), null);
});

test("#3 admin disable and delete both revoke the Siri token", async () => {
  const revoked = [];
  const users = [{ id: "u1", username: "alice" }];
  const route = loadTs("app/api/admin/users/[id]/route.ts", {
    "next/server": nextServer,
    "@/lib/auth": { getSessionUser: async () => "admin" },
    "@/lib/users": {
      getUsers: async () => clone(users), isAdminUser: () => true,
      setUserDisabled: async () => {}, deleteUser: async () => {}, revokeUserSessions: async () => {},
    },
    "@/lib/storage/persistent": { purgeUserData: async () => ({ deleted: 0 }) },
    "@/lib/auth/siri-tokens": { revokeSiriToken: async (u) => { revoked.push(u); } },
  });
  const params = { params: Promise.resolve({ id: "u1" }) };
  const disable = await route.PATCH({ json: async () => ({ action: "disable" }) }, params);
  assert.equal(disable.status, 200);
  assert.deepEqual(revoked, ["alice"]);

  const del = await route.DELETE({}, params);
  assert.equal(del.status, 200);
  assert.deepEqual(revoked, ["alice", "alice"]);
});

test("#3 self-service account deletion revokes the Siri token", async () => {
  const revoked = [];
  const route = loadTs("app/api/profile/route.ts", {
    "next/server": nextServer,
    path: require("node:path"), "fs/promises": require("node:fs/promises"),
    "@/lib/auth": { getSessionUser: async () => "alice" },
    "@/lib/users": { deleteUser: async () => {}, isAdminUser: () => false, findByUsername: async () => null },
    "@/lib/storage/persistent": { forceFlushSnapshot: async () => {}, purgeUserData: async () => ({ deleted: 0 }) },
    "@/lib/auth/siri-tokens": { revokeSiriToken: async (u) => { revoked.push(u); } },
  });
  const res = await route.DELETE();
  assert.equal(res.status, 200);
  assert.deepEqual(revoked, ["alice"]);
});

// ═════════════════════════════════════════════════════════════════════════════
// #4 — a reset link changes a password at most once
// ═════════════════════════════════════════════════════════════════════════════

function resetFixture() {
  let rows = [];
  const hash = (s) => createHash("sha256").update(s).digest("hex");
  // Each "instance" has its own /tmp-style cache AND its own lock — two warm
  // serverless instances share durable storage and nothing else.
  const instance = () => {
    let cache;
    return loadTs("lib/auth/reset-tokens.ts", {
      "@/lib/storage/lock": makeLock(),
      "@/lib/storage/secure-auth-store": {
        hashResetToken: hash,
        readResetTokenRecords: async (fresh) => { if (cache === undefined || fresh) cache = clone(rows); return clone(cache); },
        writeResetTokenRecords: async (items) => { rows = clone(items); cache = clone(items); },
      },
    });
  };
  const route = (tokensMod, changePassword) => loadTs("app/api/auth/reset-password/route.ts", {
    "next/server": nextServer,
    "@/lib/users": { changePassword },
    "@/lib/auth/reset-tokens": tokensMod,
    "@/lib/rate-limit": { checkRateLimitDurable: async () => ({ allowed: true }), getClientIp: () => "203.0.113.1" },
    "@/lib/storage/persistent": { forceFlushSnapshot: async () => {} },
  });
  const post = (r, token, newPassword = "new-password-1") => r.POST({ json: async () => ({ token, newPassword }) });
  return { instance, route, post, rows: () => rows };
}

test("#4 a link consumed on one warm instance is refused by a second instance holding a stale cache", async () => {
  const fx = resetFixture();
  const a = fx.instance(), b = fx.instance();
  const token = await a.createResetToken("alice", "alice@example.test");
  assert.equal(await b.validateResetToken("not-a-real-token"), null); // warms B's cache with the unused record

  const passwords = [];
  const changePassword = async (_u, p) => { passwords.push(p); };
  const onA = await fx.post(fx.route(a, changePassword), token, "first-attempt");
  assert.equal(onA.status, 200);

  const onB = await fx.post(fx.route(b, changePassword), token, "second-attempt");
  assert.equal(onB.status, 400, "second instance must see the consumed token");
  assert.deepEqual(passwords, ["first-attempt"]);
});

test("#4 two simultaneous submissions of one link change the password once", async () => {
  const fx = resetFixture();
  const a = fx.instance();
  const token = await a.createResetToken("alice", "alice@example.test");
  const passwords = [];
  const r = fx.route(a, async (_u, p) => { await tick(); passwords.push(p); });
  const [x, y] = await Promise.all([fx.post(r, token, "password-one"), fx.post(r, token, "password-two")]);
  assert.deepEqual([x.status, y.status].sort(), [200, 400]);
  assert.equal(passwords.length, 1);
});

test("#4 if the password write fails the claim is released so the same link can be retried", async () => {
  const fx = resetFixture();
  const a = fx.instance();
  const token = await a.createResetToken("alice", "alice@example.test");
  let fail = true;
  const passwords = [];
  const r = fx.route(a, async (_u, p) => { if (fail) throw new Error("store unavailable"); passwords.push(p); });

  const failed = await fx.post(r, token, "attempt-1");
  assert.equal(failed.status, 500);
  assert.equal(fx.rows()[0].used, false, "claim must be handed back after a failed write");

  fail = false;
  const ok = await fx.post(r, token, "attempt-2");
  assert.equal(ok.status, 200);
  assert.deepEqual(passwords, ["attempt-2"]);
  assert.equal(fx.rows()[0].used, true);
});

test("#4 validateResetToken reads fresh — a warm instance cannot report a consumed token as live", async () => {
  const fx = resetFixture();
  const a = fx.instance(), b = fx.instance();
  const token = await a.createResetToken("alice", "alice@example.test");
  await b.validateResetToken("warm-the-cache");
  assert.equal(await a.claimResetToken(token), "alice");
  assert.equal(await b.validateResetToken(token), null);
});

// ═════════════════════════════════════════════════════════════════════════════
// #8 — expensive families fail CLOSED when the spend counter is unavailable
// ═════════════════════════════════════════════════════════════════════════════

const pricing = loadTs("lib/ai/pricing.ts", {
  "./model-config": { RESERVE_OUTPUT_TOKENS: { fast: 512, default: 2048, long: 8192 } },
});

test("#8 the fail-closed set is derived from the price table, not from a family's name", () => {
  const expected = Object.entries(pricing.FAMILY_PRICING)
    .filter(([, p]) => p.outputPerM >= 25).map(([f]) => f).sort();
  const actual = Object.keys(pricing.FAMILY_PRICING).filter((f) => pricing.failsClosedOnCounterOutage(f)).sort();
  assert.deepEqual(actual, expected);
  assert.ok(actual.includes("opus5"), "the assistant's own family must be in the set");
  assert.ok(actual.includes("opus") && actual.includes("gpt56sol"));
  assert.ok(!actual.includes("haiku") && !actual.includes("gpt56luna"), "classifier tiers still fail open");
});

function guardWithCounterOutage() {
  return loadTs("lib/ai/spend-guard.ts", {
    "./pricing": { ...pricing, worstCaseCostUsd: () => 0.27 },
    "@/lib/storage/counter": { incrCounter: async () => { throw new Error("mock counter outage"); } },
    "./spend-log": { currentPeriod: () => "2026-09", currentDay: () => "2026-09-15", secondsUntilPeriodEnd: () => 100, secondsUntilDayEnd: () => 10 },
  }, { AI_GLOBAL_MONTHLY_USD: "1" });
}

test("#8 with a cap configured, an outage on the opus5 chat path refuses the request instead of reserving zero", async () => {
  const guard = guardWithCounterOutage();
  for (const family of ["opus5", "opus", "gpt56sol"]) {
    await assert.rejects(
      guard.reserveSpend({ username: "fixture", feature: "chat", family }, "default"),
      (e) => e instanceof guard.SpendCapError,
      `${family} must fail closed`,
    );
  }
});

test("#8 cheap classifier families still fail open so a counter blip cannot stall ingestion", async () => {
  const guard = guardWithCounterOutage();
  const r = await guard.reserveSpend({ username: "fixture", feature: "classify", family: "haiku" }, "fast");
  assert.equal(r.reservedUsd, 0);
});
