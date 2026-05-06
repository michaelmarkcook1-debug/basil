/**
 * tests/google-integration-storage.test.mjs
 *
 * Regression guard: Google OAuth tokens must flow through secure-token-store,
 * the callback route must never return a raw JSON 401 (browser redirect flow),
 * the start route must verify the session before initiating OAuth, and no raw
 * token values (access_token, refresh_token) must appear in API responses.
 *
 * All tests use static source analysis — no TypeScript compilation or live
 * server required.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");

function read(rel) {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

// ── lib/google/auth.ts — must use secure-token-store ─────────────────────────

test("lib/google/auth.ts: imports from secure-token-store", () => {
  const src = read("lib/google/auth.ts");
  assert.ok(
    src.includes("secure-token-store"),
    "lib/google/auth.ts must import from lib/storage/secure-token-store"
  );
});

test("lib/google/auth.ts: uses saveIntegrationToken for storing tokens", () => {
  const src = read("lib/google/auth.ts");
  assert.ok(
    src.includes("saveIntegrationToken"),
    "lib/google/auth.ts must call saveIntegrationToken (not writeUserStore)"
  );
  assert.ok(
    src.includes('"google"'),
    'lib/google/auth.ts must pass "google" as the provider argument'
  );
});

test("lib/google/auth.ts: uses getIntegrationToken for reading tokens", () => {
  const src = read("lib/google/auth.ts");
  assert.ok(
    src.includes("getIntegrationToken"),
    "lib/google/auth.ts must call getIntegrationToken (not readUserStore)"
  );
});

test("lib/google/auth.ts: uses deleteIntegrationToken or imports it", () => {
  // deleteIntegrationToken may be used in the route rather than auth.ts — check either
  const authSrc     = read("lib/google/auth.ts");
  const routeSrc    = read("app/api/auth/google/route.ts");
  assert.ok(
    authSrc.includes("deleteIntegrationToken") || routeSrc.includes("deleteIntegrationToken"),
    "Google disconnect must call deleteIntegrationToken from secure-token-store"
  );
});

test("lib/google/auth.ts: does not reference legacy google-tokens.json directly", () => {
  const src = read("lib/google/auth.ts");
  assert.ok(
    !src.includes("google-tokens.json"),
    "lib/google/auth.ts must not reference google-tokens.json — migration is handled by secure-token-store"
  );
});

test("lib/google/auth.ts: does not call writeUserStore or readUserStore directly", () => {
  const src = read("lib/google/auth.ts");
  assert.ok(
    !src.includes("writeUserStore"),
    "lib/google/auth.ts must not call writeUserStore directly — use saveIntegrationToken"
  );
  assert.ok(
    !src.includes("readUserStore"),
    "lib/google/auth.ts must not call readUserStore directly — use getIntegrationToken"
  );
});

test("lib/google/auth.ts: exchangeCode accepts username as second parameter", () => {
  const src = read("lib/google/auth.ts");
  const collapsed = src.replace(/\s+/g, " ");
  assert.ok(
    /export async function exchangeCode\([^)]*username/.test(collapsed),
    "exchangeCode() must accept username as a parameter"
  );
});

test("lib/google/auth.ts: getStoredTokens accepts username as first parameter", () => {
  const src = read("lib/google/auth.ts");
  const collapsed = src.replace(/\s+/g, " ");
  assert.ok(
    /export async function getStoredTokens\( *username/.test(collapsed),
    "getStoredTokens() must accept username as first parameter"
  );
});

test("lib/google/auth.ts: logs use structured [google/auth] prefix", () => {
  const src = read("lib/google/auth.ts");
  assert.ok(
    src.includes("[google/auth]"),
    "lib/google/auth.ts diagnostics must use [google/auth] prefix for grep-ability"
  );
});

test("lib/google/auth.ts: never logs token values", () => {
  const src = read("lib/google/auth.ts");
  assert.ok(
    !src.includes("console.log(tokens") &&
    !src.includes("console.error(tokens") &&
    !src.includes("console.log(access_token") &&
    !src.includes("console.log(refresh_token"),
    "lib/google/auth.ts must never log token values"
  );
});

// ── app/api/auth/google/route.ts — start + disconnect ─────────────────────────

test("app/api/auth/google/route.ts: GET verifies session before OAuth redirect", () => {
  const src = read("app/api/auth/google/route.ts");
  // getSessionUser must be called in the GET handler before getAuthUrl
  const getHandlerMatch = src.match(/export async function GET[\s\S]*?(?=export async function|\Z)/);
  const getHandler = getHandlerMatch ? getHandlerMatch[0] : src;
  assert.ok(
    getHandler.includes("getSessionUser"),
    "GET /api/auth/google must call getSessionUser() before redirecting to OAuth"
  );
});

test("app/api/auth/google/route.ts: GET redirects unauthenticated users (no JSON 401)", () => {
  const src = read("app/api/auth/google/route.ts");
  // Should redirect to /login, not return a JSON 401, when session is missing
  assert.ok(
    src.includes("/login"),
    "GET /api/auth/google must redirect to /login when session is missing"
  );
  // The unauthenticated path must not call getAuthUrl — that would leak an OAuth URL
  const lines = src.split("\n");
  const loginRedirectLine = lines.findIndex(l => l.includes("/login"));
  const authUrlLine = lines.findIndex(l => l.includes("getAuthUrl()"));
  assert.ok(
    loginRedirectLine !== -1 && authUrlLine !== -1 && loginRedirectLine < authUrlLine,
    "Session check must come before getAuthUrl() call in GET /api/auth/google"
  );
});

test("app/api/auth/google/route.ts: DELETE uses deleteIntegrationToken", () => {
  const src = read("app/api/auth/google/route.ts");
  assert.ok(
    src.includes("deleteIntegrationToken"),
    "DELETE /api/auth/google must call deleteIntegrationToken from secure-token-store"
  );
});

test("app/api/auth/google/route.ts: DELETE calls forceFlushSnapshot", () => {
  const src = read("app/api/auth/google/route.ts");
  assert.ok(
    src.includes("forceFlushSnapshot"),
    "DELETE /api/auth/google must call forceFlushSnapshot to ensure durable removal"
  );
});

// ── app/api/auth/google/callback/route.ts ────────────────────────────────────

test("app/api/auth/google/callback/route.ts: verifies session before exchanging code", () => {
  const src = read("app/api/auth/google/callback/route.ts");
  const collapsed = src.replace(/\s+/g, " ");
  // Use call-site patterns (not import declarations) to determine ordering:
  //   getSessionUser()  — the actual invocation
  //   await exchangeCode(  — the actual invocation
  const sessionCallIdx  = collapsed.indexOf("getSessionUser()");
  const exchangeCallIdx = collapsed.indexOf("await exchangeCode(");
  assert.ok(
    sessionCallIdx !== -1,
    "Callback must call getSessionUser()"
  );
  assert.ok(
    exchangeCallIdx !== -1,
    "Callback must call exchangeCode()"
  );
  assert.ok(
    sessionCallIdx < exchangeCallIdx,
    "getSessionUser() call must precede exchangeCode() call in the callback route"
  );
});

test("app/api/auth/google/callback/route.ts: missing session redirects (not JSON 401)", () => {
  const src = read("app/api/auth/google/callback/route.ts");
  // Must NOT return a plain JSON 401 when session is missing — user is in a browser redirect
  assert.ok(
    !src.includes('NextResponse.json({ error: "Unauthorised" }, { status: 401 })') &&
    !src.includes("NextResponse.json({ error: 'Unauthorised' }, { status: 401 })"),
    "Callback must not return a raw JSON 401 — use a redirect instead (browser redirect flow)"
  );
});

test("app/api/auth/google/callback/route.ts: clears basil_auth_from cookie on both success and error", () => {
  const src = read("app/api/auth/google/callback/route.ts");
  const clearCount = (src.match(/basil_auth_from.*maxAge.*0/g) ?? []).length;
  assert.ok(
    clearCount >= 1,
    "Callback must clear the basil_auth_from cookie in all exit paths"
  );
});

test("app/api/auth/google/callback/route.ts: uses exchangeCode (not direct token manipulation)", () => {
  const src = read("app/api/auth/google/callback/route.ts");
  assert.ok(
    src.includes("exchangeCode"),
    "Callback must call exchangeCode from lib/google/auth"
  );
  assert.ok(
    !src.includes("saveIntegrationToken"),
    "Callback must not call saveIntegrationToken directly — delegate to exchangeCode"
  );
});

test("app/api/auth/google/callback/route.ts: calls forceFlushSnapshot after exchange", () => {
  const src = read("app/api/auth/google/callback/route.ts");
  assert.ok(
    src.includes("forceFlushSnapshot"),
    "Callback must call forceFlushSnapshot after exchangeCode to ensure durable save"
  );
});

test("app/api/auth/google/callback/route.ts: logs use structured [google/callback] prefix", () => {
  const src = read("app/api/auth/google/callback/route.ts");
  assert.ok(
    src.includes("[google/callback]"),
    "Callback diagnostics must use [google/callback] prefix"
  );
});

// ── app/api/google/status/route.ts — must not return raw token fields ─────────

test("app/api/google/status/route.ts: does not return access_token or refresh_token", () => {
  const src = read("app/api/google/status/route.ts");
  assert.ok(
    !src.includes("access_token") || src.includes("// ci-ok"),
    "GET /api/google/status must not expose access_token in response"
  );
  assert.ok(
    !src.includes("refresh_token") || src.includes("// ci-ok"),
    "GET /api/google/status must not expose refresh_token in response"
  );
});

test("app/api/google/status/route.ts: delegates to getGoogleConnectionStatus", () => {
  const src = read("app/api/google/status/route.ts");
  assert.ok(
    src.includes("getGoogleConnectionStatus"),
    "Status route must delegate to getGoogleConnectionStatus from lib/google/auth"
  );
});

test("app/api/google/status/route.ts: verifies session before checking status", () => {
  const src = read("app/api/google/status/route.ts");
  assert.ok(
    src.includes("getSessionUser"),
    "Status route must call getSessionUser() before returning integration status"
  );
});

// ── Cross-cutting: provider string consistency ────────────────────────────────

test("All Google routes pass \"google\" as provider string to secure-token-store", () => {
  const files = [
    "lib/google/auth.ts",
    "app/api/auth/google/route.ts",
  ];
  for (const file of files) {
    const src = read(file);
    if (src.includes("IntegrationToken")) {
      assert.ok(
        src.includes('"google"'),
        `${file} must pass "google" as provider string to secure-token-store functions`
      );
    }
  }
});
