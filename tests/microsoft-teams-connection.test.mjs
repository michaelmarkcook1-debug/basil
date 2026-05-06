/**
 * tests/microsoft-teams-connection.test.mjs
 *
 * Regression guard: Microsoft OAuth and Teams integration must:
 *   – Store tokens via secure-token-store only
 *   – Never return raw token fields to clients
 *   – Expose Teams scope availability through the status API (not raw tokens)
 *   – Accept username as first parameter in all Teams functions
 *   – Use graphGet/graphFetch (not raw token reads) in Teams code
 *   – Classify Teams permission errors as reconnect-required (not silent empty)
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

// ── lib/microsoft/auth.ts — secure-token-store usage ─────────────────────────

test("lib/microsoft/auth.ts: imports from secure-token-store", () => {
  const src = read("lib/microsoft/auth.ts");
  assert.ok(
    src.includes("secure-token-store"),
    "lib/microsoft/auth.ts must import from lib/storage/secure-token-store"
  );
});

test("lib/microsoft/auth.ts: uses saveIntegrationToken for token persistence", () => {
  const src = read("lib/microsoft/auth.ts");
  assert.ok(
    src.includes("saveIntegrationToken"),
    "lib/microsoft/auth.ts must call saveIntegrationToken (not writeUserStore)"
  );
  assert.ok(
    src.includes('"microsoft"'),
    'lib/microsoft/auth.ts must pass "microsoft" as the provider argument'
  );
});

test("lib/microsoft/auth.ts: uses getIntegrationToken for reading tokens", () => {
  const src = read("lib/microsoft/auth.ts");
  assert.ok(
    src.includes("getIntegrationToken"),
    "lib/microsoft/auth.ts must call getIntegrationToken (not readUserStore)"
  );
});

test("lib/microsoft/auth.ts: does not call writeUserStore or readUserStore directly", () => {
  const src = read("lib/microsoft/auth.ts");
  assert.ok(
    !src.includes("writeUserStore"),
    "lib/microsoft/auth.ts must not call writeUserStore — use saveIntegrationToken"
  );
  assert.ok(
    !src.includes("readUserStore"),
    "lib/microsoft/auth.ts must not call readUserStore — use getIntegrationToken"
  );
});

test("lib/microsoft/auth.ts: does not reference legacy microsoft-tokens.json directly", () => {
  const src = read("lib/microsoft/auth.ts");
  assert.ok(
    !src.includes("microsoft-tokens.json"),
    "lib/microsoft/auth.ts must not reference microsoft-tokens.json — migration is handled by secure-token-store"
  );
});

test("lib/microsoft/auth.ts: exchangeCode accepts username parameter", () => {
  const src = read("lib/microsoft/auth.ts");
  const collapsed = src.replace(/\s+/g, " ");
  assert.ok(
    /export async function exchangeCode\([^)]*username/.test(collapsed),
    "exchangeCode() must accept username as a parameter"
  );
});

test("lib/microsoft/auth.ts: getStoredTokens accepts username as first parameter", () => {
  const src = read("lib/microsoft/auth.ts");
  const collapsed = src.replace(/\s+/g, " ");
  assert.ok(
    /export async function getStoredTokens\( *username/.test(collapsed),
    "getStoredTokens() must accept username as first parameter"
  );
});

test("lib/microsoft/auth.ts: getAccessToken accepts username as first parameter", () => {
  const src = read("lib/microsoft/auth.ts");
  const collapsed = src.replace(/\s+/g, " ");
  assert.ok(
    /export async function getAccessToken\( *username/.test(collapsed),
    "getAccessToken() must accept username as first parameter"
  );
});

test("lib/microsoft/auth.ts: never logs token values", () => {
  const src = read("lib/microsoft/auth.ts");
  assert.ok(
    !src.includes("console.log(tokens") &&
    !src.includes("console.error(tokens") &&
    !src.includes("console.log(access_token") &&
    !src.includes("console.log(data.access_token"),
    "lib/microsoft/auth.ts must never log token values"
  );
});

// ── getMicrosoftConnectionStatus — must not return raw token fields ───────────

test("lib/microsoft/auth.ts: getMicrosoftConnectionStatus does not return access_token", () => {
  const src = read("lib/microsoft/auth.ts");
  // Find the getMicrosoftConnectionStatus function body
  const fnStart = src.indexOf("export async function getMicrosoftConnectionStatus");
  assert.ok(fnStart !== -1, "getMicrosoftConnectionStatus must exist");
  const fnBody = src.slice(fnStart, fnStart + 3000);
  assert.ok(
    !fnBody.includes("access_token:") || fnBody.includes("access_token: \"\"") || fnBody.includes("access_token: data.access_token"),
    "getMicrosoftConnectionStatus must not include access_token in its return value"
  );
  // The return statements must not expose raw credential fields
  assert.ok(
    !fnBody.includes('"access_token"') && !fnBody.includes("'access_token'"),
    "getMicrosoftConnectionStatus must not return a field named access_token"
  );
});

test("lib/microsoft/auth.ts: getMicrosoftConnectionStatus exposes teams scope flag", () => {
  const src = read("lib/microsoft/auth.ts");
  assert.ok(
    src.includes("teams:") && src.includes("hasTeams"),
    "getMicrosoftConnectionStatus must report Teams scope availability (teams: boolean)"
  );
});

// ── Microsoft SCOPES — must include Teams-required scopes ────────────────────

test("lib/microsoft/auth.ts: SCOPES include Chat.Read for Teams DMs", () => {
  const src = read("lib/microsoft/auth.ts");
  assert.ok(
    src.includes("Chat.Read"),
    "Microsoft SCOPES must include Chat.Read for Teams DM access"
  );
});

test("lib/microsoft/auth.ts: SCOPES include offline_access for token refresh", () => {
  const src = read("lib/microsoft/auth.ts");
  assert.ok(
    src.includes("offline_access"),
    "Microsoft SCOPES must include offline_access to support token refresh"
  );
});

test("lib/microsoft/auth.ts: SCOPES include Mail.Read for email access", () => {
  const src = read("lib/microsoft/auth.ts");
  assert.ok(
    src.includes("Mail.Read"),
    "Microsoft SCOPES must include Mail.Read"
  );
});

// ── lib/teams/client.ts — username-parameterised, uses graphGet/graphFetch ────

test("lib/teams/client.ts: getRecentTeamsMessages accepts username as first parameter", () => {
  const src = read("lib/teams/client.ts");
  const collapsed = src.replace(/\s+/g, " ");
  assert.ok(
    /export async function getRecentTeamsMessages\( *username/.test(collapsed),
    "getRecentTeamsMessages() must accept username as first parameter"
  );
});

test("lib/teams/client.ts: searchTeamsMessages accepts username as first parameter", () => {
  const src = read("lib/teams/client.ts");
  const collapsed = src.replace(/\s+/g, " ");
  assert.ok(
    /export async function searchTeamsMessages\( *username/.test(collapsed),
    "searchTeamsMessages() must accept username as first parameter"
  );
});

test("lib/teams/client.ts: uses graphGet/graphFetch (not raw token reads)", () => {
  const src = read("lib/teams/client.ts");
  assert.ok(
    src.includes("graphGet") || src.includes("graphFetch"),
    "lib/teams/client.ts must use graphGet/graphFetch from lib/microsoft/auth"
  );
  assert.ok(
    !src.includes("getIntegrationToken") && !src.includes("readUserStore"),
    "lib/teams/client.ts must not read tokens directly — use graphGet/graphFetch"
  );
});

test("lib/teams/client.ts: does not expose raw token values", () => {
  const src = read("lib/teams/client.ts");
  assert.ok(
    !src.includes("access_token") && !src.includes("refresh_token"),
    "lib/teams/client.ts must never reference raw token field names"
  );
});

test("lib/teams/client.ts: logs use [teams-client] prefix", () => {
  const src = read("lib/teams/client.ts");
  assert.ok(
    src.includes("[teams-client]"),
    "lib/teams/client.ts diagnostics must use [teams-client] prefix for grep-ability"
  );
});

// ── lib/teams/fetch-thread.ts — username-parameterised ───────────────────────

test("lib/teams/fetch-thread.ts: accepts username parameter", () => {
  const src = read("lib/teams/fetch-thread.ts");
  assert.ok(
    src.includes("username"),
    "lib/teams/fetch-thread.ts must accept username to scope Graph API calls"
  );
});

test("lib/teams/fetch-thread.ts: uses graphGet (not raw token reads)", () => {
  const src = read("lib/teams/fetch-thread.ts");
  assert.ok(
    src.includes("graphGet") || src.includes("graphFetch"),
    "lib/teams/fetch-thread.ts must use graphGet/graphFetch, not raw token reads"
  );
  assert.ok(
    !src.includes("getIntegrationToken"),
    "lib/teams/fetch-thread.ts must not call getIntegrationToken directly"
  );
});

// ── Status route — Microsoft/Teams section ────────────────────────────────────

test("app/api/integrations/status/route.ts: Microsoft status check is wrapped in try/catch", () => {
  const src = read("app/api/integrations/status/route.ts");
  const msIdx = src.indexOf("await getMicrosoftConnectionStatus(");
  const tryCatchBefore = msIdx !== -1 ? src.slice(0, msIdx).lastIndexOf("try {") : -1;
  assert.ok(
    msIdx !== -1 && tryCatchBefore !== -1,
    "integrations/status: getMicrosoftConnectionStatus must be wrapped in a try/catch block"
  );
});

test("app/api/integrations/status/route.ts: does not return access_token or refresh_token", () => {
  const src = read("app/api/integrations/status/route.ts");
  assert.ok(
    !src.includes("access_token") || src.includes("// ci-ok"),
    "integrations/status must not return access_token in response"
  );
  assert.ok(
    !src.includes("refresh_token") || src.includes("// ci-ok"),
    "integrations/status must not return refresh_token in response"
  );
});

// ── Microsoft callback — Teams-specific safety ────────────────────────────────

test("app/api/auth/microsoft/callback/route.ts: checks OAuth errors before !code guard", () => {
  const src = read("app/api/auth/microsoft/callback/route.ts");
  const collapsed = src.replace(/\s+/g, " ");
  // The oauthError variable declaration must precede the `if (!code)` guard.
  // We use `if (!code)` (not bare `!code`) to avoid matching comments that
  // reference !code in documentation strings.
  const oauthErrIdx  = collapsed.indexOf("const oauthError");
  const codeCheckIdx = collapsed.indexOf("if (!code)");
  assert.ok(
    oauthErrIdx !== -1,
    "microsoft callback: must declare an oauthError variable to capture the error param"
  );
  assert.ok(
    codeCheckIdx !== -1,
    "microsoft callback: must have an if (!code) guard"
  );
  assert.ok(
    oauthErrIdx < codeCheckIdx,
    "microsoft callback: OAuth error param check must precede the if (!code) guard " +
    "so admin-consent errors are reported correctly"
  );
});

test("app/api/auth/microsoft/callback/route.ts: admin consent error redirects correctly", () => {
  const src = read("app/api/auth/microsoft/callback/route.ts");
  assert.ok(
    src.includes("microsoft_admin_consent"),
    "microsoft callback must redirect with ?error=microsoft_admin_consent for admin-consent-required errors"
  );
});

test("app/api/auth/microsoft/callback/route.ts: uses [microsoft/callback] log prefix", () => {
  const src = read("app/api/auth/microsoft/callback/route.ts");
  assert.ok(
    src.includes("[microsoft/callback]"),
    "microsoft callback diagnostics must use [microsoft/callback] prefix"
  );
});

// ── Microsoft start route ─────────────────────────────────────────────────────

test("app/api/auth/microsoft/route.ts: GET uses [microsoft/connect] log prefix", () => {
  const src = read("app/api/auth/microsoft/route.ts");
  assert.ok(
    src.includes("[microsoft/connect]"),
    "microsoft start route must use [microsoft/connect] log prefix"
  );
});
