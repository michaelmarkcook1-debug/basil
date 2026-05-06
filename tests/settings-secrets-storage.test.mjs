/**
 * Sprint 2C — Settings secrets hardening tests
 *
 * Verifies that:
 *  - GET /api/settings never returns raw githubToken or openaiApiKey
 *  - PATCH /api/settings routes secrets through secure-settings-store
 *  - UserSettings interface no longer carries secret fields
 *  - secure-settings-store uses AES-256-GCM encryption
 *  - Boolean "configured" flags are returned instead of raw values
 *  - Server-side callers read secrets from secure-settings-store
 *  - Cross-user isolation: secrets are namespaced per username
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { strictEqual, ok } from "assert";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/settings — must not return raw secrets
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nGET /api/settings — no raw secrets in response");

const settingsRoute = read("app/api/settings/route.ts");

test("GET handler does not return raw githubToken field", () => {
  // Must NOT have: githubToken: ... in a NextResponse.json call
  // (githubTokenConfigured is fine)
  const lines = settingsRoute.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Look for bare githubToken (not githubTokenConfigured) in a response context
    if (
      /githubToken[^C]/.test(line) &&
      !/githubToken(?:Configured|Secret|Key)/.test(line) &&
      /NextResponse\.json|return\s+NextResponse/.test(
        lines.slice(Math.max(0, i - 3), i + 1).join(" ")
      )
    ) {
      throw new Error(`Line ${i + 1}: found raw githubToken in response: ${line.trim()}`);
    }
  }
});

test("GET handler does not return raw openaiApiKey field", () => {
  const lines = settingsRoute.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (
      /openaiApiKey[^C]/.test(line) &&
      !/openaiApiKey(?:Configured|Secret)/.test(line) &&
      /NextResponse\.json|return\s+NextResponse/.test(
        lines.slice(Math.max(0, i - 3), i + 1).join(" ")
      )
    ) {
      throw new Error(`Line ${i + 1}: found raw openaiApiKey in response: ${line.trim()}`);
    }
  }
});

test("GET handler returns githubTokenConfigured boolean flag", () => {
  ok(
    /githubTokenConfigured/.test(settingsRoute),
    "Expected githubTokenConfigured in settings route"
  );
});

test("GET handler returns openaiApiKeyConfigured boolean flag", () => {
  ok(
    /openaiApiKeyConfigured/.test(settingsRoute),
    "Expected openaiApiKeyConfigured in settings route"
  );
});

test("GET handler calls listConfiguredSettingsSecrets", () => {
  ok(
    /listConfiguredSettingsSecrets/.test(settingsRoute),
    "Expected listConfiguredSettingsSecrets to be called in GET"
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/settings — must route secrets through secure store
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nPATCH /api/settings — routes secrets to encrypted store");

test("PATCH handler imports saveSettingsSecret", () => {
  ok(
    /saveSettingsSecret/.test(settingsRoute),
    "Expected saveSettingsSecret import/call in settings route"
  );
});

test("PATCH handler imports SETTINGS_SECRET_KEYS", () => {
  ok(
    /SETTINGS_SECRET_KEYS/.test(settingsRoute),
    "Expected SETTINGS_SECRET_KEYS to be used in PATCH handler"
  );
});

test("PATCH handler calls saveSettingsSecret for each secret key", () => {
  ok(
    /saveSettingsSecret\(username/.test(settingsRoute),
    "Expected saveSettingsSecret(username, ...) call in PATCH"
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// UserSettings interface — must not carry secret fields
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nUserSettings interface — no secret fields");

const settingsStore = read("lib/settings/store.ts");

test("UserSettings interface does not declare githubToken", () => {
  // Check the interface block doesn't have githubToken as a property
  const match = settingsStore.match(
    /export interface UserSettings\s*\{([^}]+)\}/s
  );
  if (match) {
    ok(
      !/githubToken/.test(match[1]),
      "UserSettings interface must not contain githubToken"
    );
  }
});

test("UserSettings interface does not declare openaiApiKey", () => {
  const match = settingsStore.match(
    /export interface UserSettings\s*\{([^}]+)\}/s
  );
  if (match) {
    ok(
      !/openaiApiKey/.test(match[1]),
      "UserSettings interface must not contain openaiApiKey"
    );
  }
});

test("settings store imports migrateLegacySettingsSecrets", () => {
  ok(
    /migrateLegacySettingsSecrets/.test(settingsStore),
    "Expected migrateLegacySettingsSecrets import for lazy migration"
  );
});

test("patchSettings allowed-keys list excludes githubToken", () => {
  // The keys array in patchSettings must not include githubToken
  const patchFn = settingsStore.match(/function patchSettings[\s\S]+?(?=^export async function|\Z)/m)?.[0] ?? settingsStore;
  const keysArray = patchFn.match(/const keys[^=]*=\s*\[([^\]]+)\]/s)?.[1] ?? "";
  ok(
    !/["'`]githubToken["'`]/.test(keysArray),
    "patchSettings keys list must not include githubToken"
  );
});

test("patchSettings allowed-keys list excludes openaiApiKey", () => {
  const patchFn = settingsStore.match(/function patchSettings[\s\S]+?(?=^export async function|\Z)/m)?.[0] ?? settingsStore;
  const keysArray = patchFn.match(/const keys[^=]*=\s*\[([^\]]+)\]/s)?.[1] ?? "";
  ok(
    !/["'`]openaiApiKey["'`]/.test(keysArray),
    "patchSettings keys list must not include openaiApiKey"
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// secure-settings-store — must encrypt with AES-256-GCM
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nsecure-settings-store — encrypted at rest");

const secureSettingsStore = read("lib/storage/secure-settings-store.ts");

test("secure-settings-store has server-only directive", () => {
  ok(
    /import\s+["']server-only["']/.test(secureSettingsStore),
    "Expected 'import server-only' directive"
  );
});

test("secure-settings-store exports getSettingsSecret", () => {
  ok(
    /export async function getSettingsSecret/.test(secureSettingsStore),
    "Expected getSettingsSecret export"
  );
});

test("secure-settings-store exports saveSettingsSecret", () => {
  ok(
    /export async function saveSettingsSecret/.test(secureSettingsStore),
    "Expected saveSettingsSecret export"
  );
});

test("secure-settings-store exports listConfiguredSettingsSecrets", () => {
  ok(
    /export async function listConfiguredSettingsSecrets/.test(secureSettingsStore),
    "Expected listConfiguredSettingsSecrets export"
  );
});

test("secure-settings-store exports migrateLegacySettingsSecrets", () => {
  ok(
    /export async function migrateLegacySettingsSecrets/.test(secureSettingsStore),
    "Expected migrateLegacySettingsSecrets export"
  );
});

test("secure-settings-store imports encrypt and decrypt from crypto module", () => {
  ok(
    /import.*encrypt.*decrypt.*from.*crypto/.test(secureSettingsStore) ||
    /from.*["'].*\/crypto["']/.test(secureSettingsStore),
    "Expected import from shared crypto module"
  );
});

test("secure-settings-store uses isEnvelope guard before decrypting", () => {
  ok(
    /isEnvelope/.test(secureSettingsStore),
    "Expected isEnvelope check before decrypt"
  );
});

test("listConfiguredSettingsSecrets returns booleans not values", () => {
  ok(
    /isEnvelope\(map\[/.test(secureSettingsStore) ||
    /isEnvelope\(.*\.githubToken\)/.test(secureSettingsStore) ||
    /isEnvelope\(map\.githubToken\)/.test(secureSettingsStore),
    "Expected isEnvelope() used to produce boolean flags"
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// shared crypto module
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nlib/storage/crypto.ts — shared AES-256-GCM helpers");

const cryptoModule = read("lib/storage/crypto.ts");

test("crypto module has server-only directive", () => {
  ok(
    /import\s+["']server-only["']/.test(cryptoModule),
    "Expected 'import server-only' directive"
  );
});

test("crypto module uses AES-256-GCM algorithm", () => {
  ok(
    /aes-256-gcm/i.test(cryptoModule),
    "Expected AES-256-GCM algorithm"
  );
});

test("crypto module exports encrypt function", () => {
  ok(
    /export function encrypt/.test(cryptoModule),
    "Expected export function encrypt"
  );
});

test("crypto module exports decrypt function", () => {
  ok(
    /export function decrypt/.test(cryptoModule),
    "Expected export function decrypt"
  );
});

test("crypto module exports isEnvelope function", () => {
  ok(
    /export function isEnvelope/.test(cryptoModule),
    "Expected export function isEnvelope"
  );
});

test("crypto module uses randomBytes for IV generation", () => {
  ok(
    /randomBytes/.test(cryptoModule),
    "Expected randomBytes for IV generation"
  );
});

test("crypto module has CI/test fallback key", () => {
  ok(
    /NODE_ENV.*test|CI.*true|alloc.*0x42/.test(cryptoModule),
    "Expected CI/test dummy key fallback"
  );
});

test("crypto module throws in production if key is missing", () => {
  ok(
    /throw|process\.exit/.test(cryptoModule),
    "Expected hard error when BASIL_TOKEN_ENCRYPTION_KEY is missing in production"
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-user isolation — secrets stored per username
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nCross-user isolation — secrets namespaced per user");

test("getSettingsSecret accepts username as first parameter", () => {
  ok(
    /export async function getSettingsSecret\(\s*username/.test(secureSettingsStore),
    "Expected username as first param of getSettingsSecret"
  );
});

test("saveSettingsSecret accepts username as first parameter", () => {
  ok(
    /export async function saveSettingsSecret\(\s*username/.test(secureSettingsStore),
    "Expected username as first param of saveSettingsSecret"
  );
});

test("listConfiguredSettingsSecrets accepts username as first parameter", () => {
  ok(
    /export async function listConfiguredSettingsSecrets\(\s*username/.test(secureSettingsStore),
    "Expected username as first param of listConfiguredSettingsSecrets"
  );
});

test("secrets stored in per-user file path (readUserStore/writeUserStore)", () => {
  ok(
    /readUserStore/.test(secureSettingsStore) &&
    /writeUserStore/.test(secureSettingsStore),
    "Expected readUserStore/writeUserStore for per-user namespacing"
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Server-side callers use secure store
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nServer-side callers — read secrets from secure store");

const syncTs = read("lib/ai-projects/sync.ts");

test("sync.ts imports getSettingsSecret", () => {
  ok(
    /getSettingsSecret/.test(syncTs),
    "Expected getSettingsSecret import in sync.ts"
  );
});

test("sync.ts reads githubToken via getSettingsSecret", () => {
  ok(
    /getSettingsSecret\(username,\s*["']githubToken["']/.test(syncTs),
    "Expected getSettingsSecret(username, 'githubToken') call in sync.ts"
  );
});

test("sync.ts reads openaiApiKey via getSettingsSecret", () => {
  ok(
    /getSettingsSecret\(username,\s*["']openaiApiKey["']/.test(syncTs),
    "Expected getSettingsSecret(username, 'openaiApiKey') call in sync.ts"
  );
});

test("sync.ts does not read secrets from settings object", () => {
  ok(
    !/settings\.githubToken/.test(syncTs) &&
    !/settings\.openaiApiKey/.test(syncTs),
    "sync.ts must not access secrets via settings object"
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Results
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}
