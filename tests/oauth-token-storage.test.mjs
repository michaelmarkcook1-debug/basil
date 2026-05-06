/**
 * tests/oauth-token-storage.test.mjs
 *
 * Regression guard: OAuth/integration tokens must be encrypted at rest and
 * never stored as plaintext.
 *
 * All tests use static source analysis so they run without TypeScript
 * compilation and without a live server.  They assert the STRUCTURAL
 * properties of the code that enforce token security — if anyone moves a token
 * write back to a raw writeUserStore call, a test here fails in CI.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");

function read(rel) {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

// ── secure-token-store.ts structural checks ──────────────────────────────────

test("secure-token-store uses AES-256-GCM encryption", () => {
  const src = read("lib/storage/secure-token-store.ts");
  // Crypto primitives may live in the shared crypto.ts module that this file imports
  const cryptoSrc = (() => { try { return read("lib/storage/crypto.ts"); } catch { return ""; } })();
  const combined = src + cryptoSrc;
  assert.ok(
    combined.includes("aes-256-gcm"),
    "secure-token-store (or shared crypto module) must use AES-256-GCM"
  );
  assert.ok(
    combined.includes("createCipheriv") && combined.includes("createDecipheriv"),
    "secure-token-store (or shared crypto module) must use createCipheriv / createDecipheriv"
  );
  assert.ok(
    combined.includes("getAuthTag"),
    "secure-token-store (or shared crypto module) must call getAuthTag (authenticated encryption)"
  );
});

test("secure-token-store has server-only directive", () => {
  const src = read("lib/storage/secure-token-store.ts");
  assert.ok(
    src.includes('"server-only"') || src.includes("'server-only'"),
    "secure-token-store must import server-only to prevent client bundle inclusion"
  );
});

test("secure-token-store requires BASIL_TOKEN_ENCRYPTION_KEY in production", () => {
  const src = read("lib/storage/secure-token-store.ts");
  const cryptoSrc = (() => { try { return read("lib/storage/crypto.ts"); } catch { return ""; } })();
  const combined = src + cryptoSrc;
  assert.ok(
    combined.includes("BASIL_TOKEN_ENCRYPTION_KEY"),
    "secure-token-store (or shared crypto module) must reference BASIL_TOKEN_ENCRYPTION_KEY"
  );
  assert.ok(
    combined.includes("throw new Error"),
    "secure-token-store (or shared crypto module) must throw when key is missing in production"
  );
});

test("secure-token-store allows CI/test fallback key", () => {
  const src = read("lib/storage/secure-token-store.ts");
  const cryptoSrc = (() => { try { return read("lib/storage/crypto.ts"); } catch { return ""; } })();
  const combined = src + cryptoSrc;
  assert.ok(
    combined.includes('NODE_ENV === "test"') || combined.includes("CI"),
    "secure-token-store (or shared crypto module) must allow a dummy key in test/CI environments"
  );
});

test("secure-token-store stores an encrypted envelope (not plaintext)", () => {
  const src = read("lib/storage/secure-token-store.ts");
  const cryptoSrc = (() => { try { return read("lib/storage/crypto.ts"); } catch { return ""; } })();
  const combined = src + cryptoSrc;
  // The envelope must have iv, tag, and data — not the raw token fields
  assert.ok(
    combined.includes("iv:") && combined.includes("tag:") && combined.includes("data:"),
    "secure-token-store (or shared crypto module) must define iv, tag, and data envelope fields"
  );
  // Must not store plaintext token values at the top level
  assert.ok(
    !src.includes('"access_token"') && !src.includes("'access_token'"),
    "secure-token-store must not reference access_token as a stored key"
  );
  assert.ok(
    !src.includes('"refresh_token"') && !src.includes("'refresh_token'"),
    "secure-token-store must not reference refresh_token as a stored key"
  );
});

test("secure-token-store uses randomBytes for IV (fresh per write)", () => {
  const src = read("lib/storage/secure-token-store.ts");
  const cryptoSrc = (() => { try { return read("lib/storage/crypto.ts"); } catch { return ""; } })();
  const combined = src + cryptoSrc;
  assert.ok(
    combined.includes("randomBytes"),
    "secure-token-store (or shared crypto module) must generate a fresh random IV per write"
  );
});

test("secure-token-store exports getIntegrationToken, saveIntegrationToken, deleteIntegrationToken", () => {
  const src = read("lib/storage/secure-token-store.ts");
  for (const fn of ["getIntegrationToken", "saveIntegrationToken", "deleteIntegrationToken", "listConnectedProviders"]) {
    assert.ok(
      src.includes(`export async function ${fn}`),
      `secure-token-store must export ${fn}`
    );
  }
});

test("secure-token-store functions accept username as first parameter", () => {
  const src = read("lib/storage/secure-token-store.ts");
  const collapsed = src.replace(/\s+/g, " ");
  for (const fn of ["getIntegrationToken", "saveIntegrationToken", "deleteIntegrationToken", "listConnectedProviders"]) {
    // Allow optional generic type params: function foo<T>(username  or  function foo(username
    const pattern = new RegExp(`export async function ${fn}(?:<[^>]*>)?\\( *username`);
    assert.ok(
      pattern.test(collapsed),
      `${fn}() must accept username as first parameter`
    );
  }
});

test("secure-token-store functions accept provider as second parameter", () => {
  const src = read("lib/storage/secure-token-store.ts");
  const collapsed = src.replace(/\s+/g, " ");
  for (const fn of ["getIntegrationToken", "saveIntegrationToken", "deleteIntegrationToken"]) {
    // Allow optional generic type params before the opening paren
    const pattern = new RegExp(`export async function ${fn}(?:<[^>]*>)?\\([^)]*username[^)]*provider`);
    assert.ok(
      pattern.test(collapsed),
      `${fn}() must accept provider as second parameter (after username)`
    );
  }
});

test("secure-token-store never logs token values", () => {
  const src = read("lib/storage/secure-token-store.ts");
  // Should not contain console.log/error/warn with tokenPayload or plaintext
  assert.ok(
    !src.includes("console.log(tokenPayload") &&
    !src.includes("console.log(plaintext") &&
    !src.includes("console.error(tokenPayload") &&
    !src.includes("console.error(plaintext"),
    "secure-token-store must never log token payload or plaintext"
  );
});

// ── Provider auth lib checks — must use secure-token-store ───────────────────

const PROVIDER_LIBS = [
  { file: "lib/google/auth.ts",     provider: "google",    legacyFile: "google-tokens.json" },
  { file: "lib/microsoft/auth.ts",  provider: "microsoft", legacyFile: "microsoft-tokens.json" },
  { file: "lib/zoom/auth.ts",       provider: "zoom",      legacyFile: "zoom-tokens.json" },
  { file: "lib/slack/client.ts",    provider: "slack",     legacyFile: "slack-config.json" },
  { file: "lib/linear/client.ts",   provider: "linear",    legacyFile: "linear-config.json" },
];

for (const { file, provider, legacyFile } of PROVIDER_LIBS) {
  test(`${file}: imports from secure-token-store`, () => {
    const src = read(file);
    assert.ok(
      src.includes("secure-token-store"),
      `${file} must import from lib/storage/secure-token-store`
    );
  });

  test(`${file}: does not write to legacy plaintext file directly`, () => {
    const src = read(file);
    assert.ok(
      !src.includes(`writeUserStore`) || !src.includes(`"${legacyFile}"`),
      `${file} must not call writeUserStore("${legacyFile}") — use saveIntegrationToken instead`
    );
    assert.ok(
      !src.includes(`writeStore`) || !src.includes(`"${legacyFile}"`),
      `${file} must not call writeStore("${legacyFile}") — use saveIntegrationToken instead`
    );
  });

  test(`${file}: does not read legacy plaintext file directly`, () => {
    const src = read(file);
    assert.ok(
      !src.includes(`readUserStore`) || !src.includes(`"${legacyFile}"`),
      `${file} must not call readUserStore("${legacyFile}") — use getIntegrationToken instead`
    );
  });

  test(`${file}: uses saveIntegrationToken or getIntegrationToken for "${provider}"`, () => {
    const src = read(file);
    const usesSave = src.includes("saveIntegrationToken");
    const usesGet  = src.includes("getIntegrationToken");
    assert.ok(
      usesSave || usesGet,
      `${file} must use saveIntegrationToken or getIntegrationToken from secure-token-store`
    );
    // The provider string must appear in calls to the store functions
    assert.ok(
      src.includes(`"${provider}"`),
      `${file} must pass "${provider}" as the provider argument`
    );
  });
}

// ── Disconnect routes must use deleteIntegrationToken ────────────────────────

// Routes that must not write token files directly — they delegate to a
// secure-store-backed helper (deleteIntegrationToken or a provider disconnect fn).
const DISCONNECT_ROUTES = [
  { file: "app/api/auth/google/route.ts",    acceptFns: ["deleteIntegrationToken"] },
  { file: "app/api/auth/microsoft/route.ts", acceptFns: ["deleteIntegrationToken"] },
  // Zoom routes through disconnectZoom() which internally calls deleteIntegrationToken
  { file: "app/api/auth/zoom/route.ts",      acceptFns: ["deleteIntegrationToken", "disconnectZoom"] },
];

for (const { file, acceptFns } of DISCONNECT_ROUTES) {
  test(`${file}: disconnect uses secure delete (not raw writeUserStore)`, () => {
    const src = read(file);
    const usesSecureDelete = acceptFns.some((fn) => src.includes(fn));
    assert.ok(
      usesSecureDelete,
      `${file}: disconnect must call one of [${acceptFns.join(", ")}], not write null via writeUserStore`
    );
    // Must not write to legacy plaintext token files directly
    const legacyFiles = ["google-tokens.json", "microsoft-tokens.json", "zoom-tokens.json"];
    for (const lf of legacyFiles) {
      if (src.includes(lf)) {
        assert.ok(
          !src.includes("writeUserStore") || !src.includes(`"${lf}"`),
          `${file}: must not writeUserStore("${lf}") directly`
        );
      }
    }
  });
}

test("app/api/auth/slack/route.ts: disconnect uses deleteSlackConfig (not raw writeUserStore)", () => {
  const src = read("app/api/auth/slack/route.ts");
  assert.ok(
    src.includes("deleteSlackConfig"),
    "slack disconnect route must call deleteSlackConfig"
  );
  assert.ok(
    !src.includes("slack-config.json"),
    "slack disconnect route must not reference slack-config.json directly"
  );
});

test("app/api/auth/linear/route.ts: disconnect uses deleteLinearConfig (not raw writeUserStore)", () => {
  const src = read("app/api/auth/linear/route.ts");
  assert.ok(
    src.includes("deleteLinearConfig"),
    "linear disconnect route must call deleteLinearConfig"
  );
});

// ── Status/health routes must not return raw token fields ────────────────────

const STATUS_ROUTES = [
  "app/api/integrations/status/route.ts",
  "app/api/google/status/route.ts",
  "app/api/system/health/route.ts",
  "app/api/health/route.ts",
];

for (const route of STATUS_ROUTES) {
  test(`${route}: does not return access_token or refresh_token in response`, () => {
    const src = read(route);
    assert.ok(
      !src.includes("access_token") || src.includes("// ci-ok"),
      `${route}: must not include access_token in response`
    );
    assert.ok(
      !src.includes("refresh_token") || src.includes("// ci-ok"),
      `${route}: must not include refresh_token in response`
    );
    assert.ok(
      !src.includes("botToken") || src.includes("// ci-ok"),
      `${route}: must not include botToken in response`
    );
    assert.ok(
      !src.includes("apiKey") || src.includes("// ci-ok"),
      `${route}: must not include apiKey in response`
    );
  });
}

// ── Encryption key never hardcoded ───────────────────────────────────────────

test("secure-token-store never hardcodes an encryption key", () => {
  const src = read("lib/storage/secure-token-store.ts");
  // Should not contain hex strings that look like a 64-char key
  const hexKeyPattern = /['"'][0-9a-f]{64}['"']/i;
  assert.ok(
    !hexKeyPattern.test(src),
    "secure-token-store must not hardcode a 64-char hex encryption key"
  );
});

// ── Cross-user isolation: provider scoping ───────────────────────────────────

test("secure-token-store scopes token files by both username and provider", () => {
  const src = read("lib/storage/secure-token-store.ts");
  // File names must incorporate the provider name
  assert.ok(
    src.includes("secure-tokens-") || src.includes("`secure-tokens-${provider}`"),
    "secure-token-store must include provider name in the storage filename for isolation"
  );
  // Must use readUserStore (which already scopes by username)
  assert.ok(
    src.includes("readUserStore") && src.includes("writeUserStore"),
    "secure-token-store must use readUserStore/writeUserStore for per-user scoping"
  );
});
