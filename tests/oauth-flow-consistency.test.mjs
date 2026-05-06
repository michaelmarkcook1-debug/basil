/**
 * tests/oauth-flow-consistency.test.mjs
 *
 * Regression guard: every OAuth provider must follow the same browser-safe
 * flow contract:
 *   – START route: verify session before generating the provider auth URL
 *   – CALLBACK: redirect (not JSON 401) when session is missing
 *   – CALLBACK: redirect on provider errors
 *   – DISCONNECT: require session
 *   – All token ops via secure-token-store
 *
 * Tests use static source analysis only — no TypeScript compilation or live
 * server required.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");

function read(rel) {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

function exists(rel) {
  return existsSync(resolve(ROOT, rel));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** True if a redirect call to /login appears in the src. */
function redirectsToLogin(src) {
  return src.includes("/login");
}

/** True if the src contains a raw JSON 401 that is NOT the disconnect handler. */
function hasJson401InBrowserFlow(src) {
  // Disconnect routes are allowed to return JSON 401 (they are API calls, not redirects).
  // We only flag it when it appears in a GET handler that handles browser redirects.
  // Heuristic: look for the pattern inside an async function GET block.
  const getHandlerMatch = src.match(/export async function GET[\s\S]*?(?=^export async function|\Z)/m);
  if (!getHandlerMatch) return false;
  const getBlock = getHandlerMatch[0];
  return (
    getBlock.includes('NextResponse.json({ error: "Unauthorised" }, { status: 401 })') ||
    getBlock.includes("NextResponse.json({ error: 'Unauthorised' }, { status: 401 })")
  );
}

// ── Provider matrix ───────────────────────────────────────────────────────────

const PROVIDERS = [
  {
    name:         "google",
    startFile:    "app/api/auth/google/route.ts",
    callbackFile: "app/api/auth/google/callback/route.ts",
    provider:     "google",
  },
  {
    name:         "microsoft",
    startFile:    "app/api/auth/microsoft/route.ts",
    callbackFile: "app/api/auth/microsoft/callback/route.ts",
    provider:     "microsoft",
  },
  {
    name:         "zoom",
    startFile:    "app/api/auth/zoom/route.ts",
    callbackFile: "app/api/auth/zoom/callback/route.ts",
    provider:     "zoom",
  },
  {
    name:         "slack",
    startFile:    "app/api/auth/slack/oauth/route.ts",
    callbackFile: "app/api/auth/slack/callback/route.ts",
    provider:     "slack",
  },
];

for (const { name, startFile, callbackFile, provider } of PROVIDERS) {
  // ── Start route ──────────────────────────────────────────────────────────

  test(`${name} start route: requires getSessionUser() before generating auth URL`, () => {
    const src = read(startFile);
    assert.ok(
      src.includes("getSessionUser"),
      `${startFile}: GET must call getSessionUser() before redirecting to ${name} OAuth`
    );
  });

  test(`${name} start route: redirects unauthenticated users to /login (no JSON 401)`, () => {
    const src = read(startFile);
    assert.ok(
      redirectsToLogin(src),
      `${startFile}: must redirect to /login when session is missing`
    );
    assert.ok(
      !hasJson401InBrowserFlow(src),
      `${startFile}: GET handler must not return a raw JSON 401 — use a redirect instead`
    );
  });

  // ── Callback route ───────────────────────────────────────────────────────

  test(`${name} callback: does not return raw JSON 401 (browser redirect flow)`, () => {
    const src = read(callbackFile);
    assert.ok(
      !hasJson401InBrowserFlow(src),
      `${callbackFile}: must redirect instead of returning JSON 401 when session is missing`
    );
  });

  test(`${name} callback: calls getSessionUser() before exchanging the code`, () => {
    const src      = read(callbackFile);
    const collapsed = src.replace(/\s+/g, " ");
    const sessionIdx  = collapsed.indexOf("getSessionUser()");
    // The exchange/token-save call names vary by provider
    const exchangePatterns = ["await exchangeCode(", "await exchangeZoomCode(", "saveSlackConfig(", "saveIntegrationToken("];
    const exchangeIdx = Math.min(
      ...exchangePatterns.map(p => {
        const i = collapsed.indexOf(p);
        return i === -1 ? Infinity : i;
      })
    );
    assert.ok(sessionIdx !== -1, `${callbackFile}: must call getSessionUser()`);
    assert.ok(
      sessionIdx < exchangeIdx,
      `${callbackFile}: getSessionUser() must be called before the token exchange/save`
    );
  });

  test(`${name} callback: clears the from-cookie on all exit paths`, () => {
    const src      = read(callbackFile);
    // Each provider uses a slightly different cookie name
    const cookieNames = ["basil_auth_from", "basil_zoom_from", "basil_slack_from"];
    const hasCookieClear = cookieNames.some(name =>
      src.includes(name) && src.includes("maxAge: 0")
    );
    assert.ok(hasCookieClear, `${callbackFile}: must clear the OAuth from-cookie on all exit paths`);
  });

  // ── Disconnect: token uses secure-token-store ────────────────────────────

  test(`${name} disconnect: uses secure token deletion (deleteIntegrationToken or provider helper)`, () => {
    const startSrc    = read(startFile);
    const callbackSrc = read(callbackFile);
    // Slack's disconnect lives in the base route, not the oauth start/callback
    const slackBaseSrc = exists("app/api/auth/slack/route.ts")
      ? read("app/api/auth/slack/route.ts") : "";
    const combined    = startSrc + callbackSrc + slackBaseSrc;
    const secureDelete = [
      "deleteIntegrationToken",
      "disconnectZoom",
      "deleteSlackConfig",
      "deleteLinearConfig",
    ];
    const usesSecureDelete = secureDelete.some(fn => combined.includes(fn));
    assert.ok(
      usesSecureDelete,
      `${name} routes must use a secure delete helper (deleteIntegrationToken or equivalent)`
    );
  });
}

// ── Zoom callback: specific safety checks ────────────────────────────────────

test("zoom callback: redirects to /login on missing session (not JSON 401)", () => {
  const src = read("app/api/auth/zoom/callback/route.ts");
  assert.ok(
    redirectsToLogin(src),
    "zoom callback must redirect to /login when session is missing"
  );
});

// ── Slack OAuth start route ───────────────────────────────────────────────────

test("slack oauth start route: requires session before redirecting", () => {
  const src = read("app/api/auth/slack/oauth/route.ts");
  assert.ok(
    src.includes("getSessionUser"),
    "app/api/auth/slack/oauth/route.ts: must call getSessionUser() before redirecting to Slack OAuth"
  );
  assert.ok(
    redirectsToLogin(src),
    "app/api/auth/slack/oauth/route.ts: must redirect to /login when session is missing"
  );
});

// ── All provider start routes: session check precedes auth URL generation ────

test("no OAuth start route generates an auth URL before verifying session", () => {
  const startRoutes = [
    { file: "app/api/auth/google/route.ts",    authFn: "getAuthUrl()" },
    { file: "app/api/auth/microsoft/route.ts", authFn: "getMicrosoftAuthUrl(" },
    { file: "app/api/auth/zoom/route.ts",      authFn: "getZoomAuthUrl()" },
    { file: "app/api/auth/slack/oauth/route.ts", authFn: "generateAuthUrl\|slack" },
  ];

  for (const { file, authFn } of startRoutes) {
    if (!exists(file)) continue;
    const collapsed = read(file).replace(/\s+/g, " ");
    const sessionIdx = collapsed.indexOf("getSessionUser()");
    // Find the position of the auth URL generation call
    const patterns = authFn.split("\\|");
    const authIdx  = Math.min(
      ...patterns.map(p => {
        const i = collapsed.indexOf(p);
        return i === -1 ? Infinity : i;
      })
    );
    assert.ok(sessionIdx !== -1, `${file}: must call getSessionUser()`);
    assert.ok(
      sessionIdx < authIdx,
      `${file}: session check must precede auth URL generation`
    );
  }
});

// ── All callbacks: no raw JSON 401 anywhere in GET handlers ──────────────────

test("no OAuth callback returns a raw JSON 401 in its GET handler", () => {
  const callbacks = [
    "app/api/auth/google/callback/route.ts",
    "app/api/auth/microsoft/callback/route.ts",
    "app/api/auth/zoom/callback/route.ts",
    "app/api/auth/slack/callback/route.ts",
  ];
  for (const file of callbacks) {
    if (!exists(file)) continue;
    const src = read(file);
    assert.ok(
      !hasJson401InBrowserFlow(src),
      `${file}: OAuth callback GET handler must not return a raw JSON 401 (browser redirect flow)`
    );
  }
});

// ── Disconnect routes: session guard present ──────────────────────────────────

test("all provider disconnect routes require an active session", () => {
  const disconnectRoutes = [
    "app/api/auth/google/route.ts",
    "app/api/auth/microsoft/route.ts",
    "app/api/auth/zoom/route.ts",
  ];
  for (const file of disconnectRoutes) {
    if (!exists(file)) continue;
    const src = read(file);
    // DELETE handler must call getSessionUser
    const deleteMatch = src.match(/export async function DELETE[\s\S]*?(?=^export async function|\Z)/m);
    const deleteBlock = deleteMatch ? deleteMatch[0] : src;
    assert.ok(
      deleteBlock.includes("getSessionUser"),
      `${file}: DELETE handler must call getSessionUser() before deleting tokens`
    );
  }
});

// ── integrations/status: all checks wrapped in try/catch ─────────────────────

test("integrations/status/route.ts: Slack status check is wrapped in try/catch", () => {
  const src = read("app/api/integrations/status/route.ts");
  // Use the await call-site (not the import declaration) to find the right position
  const slackIdx = src.indexOf("await isSlackConnected(");
  const tryCatchBefore = slackIdx !== -1 ? src.slice(0, slackIdx).lastIndexOf("try {") : -1;
  assert.ok(
    slackIdx !== -1 && tryCatchBefore !== -1,
    "integrations/status: isSlackConnected must be called inside a try/catch block"
  );
});

test("integrations/status/route.ts: Linear status check is wrapped in try/catch", () => {
  const src = read("app/api/integrations/status/route.ts");
  const linearIdx = src.indexOf("await isLinearConnected(");
  const tryCatchBefore = linearIdx !== -1 ? src.slice(0, linearIdx).lastIndexOf("try {") : -1;
  assert.ok(
    linearIdx !== -1 && tryCatchBefore !== -1,
    "integrations/status: isLinearConnected must be called inside a try/catch block"
  );
});

test("integrations/status/route.ts: Zoom status check is wrapped in try/catch", () => {
  const src = read("app/api/integrations/status/route.ts");
  const zoomIdx = src.indexOf("await isZoomConnected(");
  const tryCatchBefore = zoomIdx !== -1 ? src.slice(0, zoomIdx).lastIndexOf("try {") : -1;
  assert.ok(
    zoomIdx !== -1 && tryCatchBefore !== -1,
    "integrations/status: isZoomConnected must be called inside a try/catch block"
  );
});
