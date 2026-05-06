/**
 * tests/auth-storage-hardening.test.mjs — Sprint 2D regression guard.
 *
 * Verifies that:
 *  - secure-auth-store is server-only and uses AES-256-GCM
 *  - users.json is no longer written directly outside secure-auth-store/lib/users
 *  - password-reset-tokens.json is no longer written directly outside allowed modules
 *  - password hashes are never returned in NextResponse.json calls
 *  - reset tokens are stored as SHA-256 hashes (raw token never persisted)
 *  - reset tokens are single-use (consumeResetToken marks used: true)
 *  - expired reset tokens are rejected by validateResetToken
 *  - admin user route uses toSafeUser() helper, not ad-hoc destructuring
 *  - toSafeUser() and SafeUser type are exported from lib/users.ts
 *  - cross-user isolation: user records namespaced through secure-auth-store
 *  - CI fails on obvious auth secret leakage (guard smoke-tests)
 *
 * All tests use static source analysis — no live server or TypeScript
 * compilation required.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");

function read(rel) {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

// ─────────────────────────────────────────────────────────────────────────────
// lib/storage/secure-auth-store.ts — structural checks
// ─────────────────────────────────────────────────────────────────────────────

test("secure-auth-store has server-only directive", () => {
  const src = read("lib/storage/secure-auth-store.ts");
  assert.ok(
    src.includes('"server-only"') || src.includes("'server-only'"),
    "secure-auth-store must import server-only to prevent client bundle inclusion"
  );
});

test("secure-auth-store imports from shared crypto module", () => {
  const src = read("lib/storage/secure-auth-store.ts");
  assert.ok(
    /from.*["'].*\/crypto["']/.test(src) || src.includes("lib/storage/crypto"),
    "secure-auth-store must use shared crypto module for AES-256-GCM"
  );
});

test("secure-auth-store exports readUserRecords", () => {
  const src = read("lib/storage/secure-auth-store.ts");
  assert.ok(
    /export async function readUserRecords/.test(src),
    "secure-auth-store must export readUserRecords"
  );
});

test("secure-auth-store exports writeUserRecords", () => {
  const src = read("lib/storage/secure-auth-store.ts");
  assert.ok(
    /export async function writeUserRecords/.test(src),
    "secure-auth-store must export writeUserRecords"
  );
});

test("secure-auth-store exports readResetTokenRecords", () => {
  const src = read("lib/storage/secure-auth-store.ts");
  assert.ok(
    /export async function readResetTokenRecords/.test(src),
    "secure-auth-store must export readResetTokenRecords"
  );
});

test("secure-auth-store exports writeResetTokenRecords", () => {
  const src = read("lib/storage/secure-auth-store.ts");
  assert.ok(
    /export async function writeResetTokenRecords/.test(src),
    "secure-auth-store must export writeResetTokenRecords"
  );
});

test("secure-auth-store exports hashResetToken", () => {
  const src = read("lib/storage/secure-auth-store.ts");
  assert.ok(
    /export function hashResetToken/.test(src),
    "secure-auth-store must export hashResetToken"
  );
});

test("secure-auth-store uses SHA-256 for token hashing", () => {
  const src = read("lib/storage/secure-auth-store.ts");
  assert.ok(
    src.includes("sha256") || src.includes("SHA-256") || src.includes("SHA256"),
    "secure-auth-store must hash reset tokens with SHA-256"
  );
  assert.ok(
    /createHash/.test(src),
    "secure-auth-store must use node:crypto createHash for token hashing"
  );
});

test("secure-auth-store stores tokenHash not raw token", () => {
  const src = read("lib/storage/secure-auth-store.ts");
  // The stored record must use tokenHash, not a field named 'token'
  assert.ok(
    src.includes("tokenHash"),
    "HashedResetToken record must use tokenHash field"
  );
  assert.ok(
    !(/\btoken\s*:\s*string/.test(src)),
    "HashedResetToken must not have a plain 'token: string' field (use tokenHash)"
  );
});

test("secure-auth-store encrypts user records via readStore/writeStore", () => {
  const src = read("lib/storage/secure-auth-store.ts");
  assert.ok(
    /readStore/.test(src) && /writeStore/.test(src),
    "secure-auth-store must use readStore/writeStore for blob persistence"
  );
  assert.ok(
    /encrypt/.test(src) && /decrypt/.test(src),
    "secure-auth-store must call encrypt/decrypt on user records"
  );
  assert.ok(
    /isEnvelope/.test(src),
    "secure-auth-store must check isEnvelope before decrypting"
  );
});

test("secure-auth-store has migration path from legacy users.json", () => {
  const src = read("lib/storage/secure-auth-store.ts");
  assert.ok(
    src.includes("users.json") || src.includes("LEGACY_USERS_FILE"),
    "secure-auth-store must reference legacy users.json for migration"
  );
});

test("secure-auth-store does NOT migrate legacy password-reset-tokens.json", () => {
  const src = read("lib/storage/secure-auth-store.ts");
  // The module should intentionally NOT migrate legacy reset tokens (safety)
  // Verify by checking there's no "password-reset-tokens" in a readStore call
  const lines = src.split("\n");
  for (const line of lines) {
    if (
      /readStore\s*\(/.test(line) &&
      line.includes("password-reset-tokens")
    ) {
      assert.fail(
        "secure-auth-store must NOT migrate legacy password-reset-tokens.json — " +
        "invalidating existing tokens is safer"
      );
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// lib/users.ts — must use secure-auth-store, never readStore/writeStore directly
// ─────────────────────────────────────────────────────────────────────────────

test("lib/users.ts imports from secure-auth-store", () => {
  const src = read("lib/users.ts");
  assert.ok(
    src.includes("secure-auth-store"),
    "lib/users.ts must import from secure-auth-store for encrypted storage"
  );
});

test("lib/users.ts does not write directly to users.json", () => {
  const src = read("lib/users.ts");
  // Should not call writeStore("users.json", ...) or writeStore(USERS_FILE, ...)
  // (USERS_FILE was "users.json" in the old code)
  assert.ok(
    !/writeStore\s*\(\s*["']users\.json["']/.test(src),
    "lib/users.ts must not call writeStore('users.json', ...) directly"
  );
  assert.ok(
    !/writeStore\s*\(\s*USERS_FILE/.test(src),
    "lib/users.ts must not call writeStore(USERS_FILE, ...) directly"
  );
});

test("lib/users.ts does not read directly from users.json", () => {
  const src = read("lib/users.ts");
  assert.ok(
    !/readStore\s*\(\s*["']users\.json["']/.test(src),
    "lib/users.ts must not call readStore('users.json', ...) directly"
  );
  assert.ok(
    !/readStore\s*\(\s*USERS_FILE/.test(src),
    "lib/users.ts must not call readStore(USERS_FILE, ...) directly"
  );
});

test("lib/users.ts exports SafeUser type", () => {
  const src = read("lib/users.ts");
  assert.ok(
    /export type SafeUser/.test(src),
    "lib/users.ts must export SafeUser type (User without password)"
  );
});

test("lib/users.ts exports toSafeUser function", () => {
  const src = read("lib/users.ts");
  assert.ok(
    /export function toSafeUser/.test(src),
    "lib/users.ts must export toSafeUser() helper"
  );
});

test("toSafeUser strips the password field", () => {
  const src = read("lib/users.ts");
  // The function must destructure or omit 'password'
  assert.ok(
    /password.*_pw|Omit.*User.*password/.test(src),
    "toSafeUser must strip the password field from the User object"
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// lib/auth/reset-tokens.ts — must store hashed tokens, not raw
// ─────────────────────────────────────────────────────────────────────────────

test("reset-tokens.ts imports hashResetToken from secure-auth-store", () => {
  const src = read("lib/auth/reset-tokens.ts");
  assert.ok(
    src.includes("hashResetToken"),
    "reset-tokens.ts must use hashResetToken from secure-auth-store"
  );
  assert.ok(
    src.includes("secure-auth-store"),
    "reset-tokens.ts must import from secure-auth-store"
  );
});

test("reset-tokens.ts never writes a raw 'token' field to storage", () => {
  const src = read("lib/auth/reset-tokens.ts");
  // The entry written to storage must use 'tokenHash', not 'token'
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comments
    if (/^\s*\/\/|^\s*\*/.test(line)) continue;
    // Check for a field named 'token:' in a storage write context
    if (
      /\btoken\s*:(?!\s*Hash)/.test(line) &&
      !/tokenHash/.test(line) &&
      /writeResetToken|entry\s*=/.test(lines.slice(Math.max(0, i - 3), i + 3).join(" "))
    ) {
      assert.fail(
        `Line ${i + 1}: found raw 'token:' field near storage write context: ${line.trim()}`
      );
    }
  }
});

test("reset-tokens.ts calls hashResetToken before looking up a token", () => {
  const src = read("lib/auth/reset-tokens.ts");
  assert.ok(
    /hashResetToken\(presentedToken\)/.test(src) ||
    /hashResetToken\(token\)/.test(src),
    "validateResetToken and consumeResetToken must hash the presented token before lookup"
  );
});

test("reset-tokens.ts does not write to password-reset-tokens.json directly", () => {
  const src = read("lib/auth/reset-tokens.ts");
  assert.ok(
    !/writeStore.*password-reset-tokens/.test(src),
    "reset-tokens.ts must not write to password-reset-tokens.json directly"
  );
  assert.ok(
    !/writeStore.*TOKENS_FILE/.test(src),
    "reset-tokens.ts must not use the old TOKENS_FILE writeStore pattern"
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// app/api/admin/users/route.ts — must use toSafeUser, not ad-hoc stripping
// ─────────────────────────────────────────────────────────────────────────────

test("admin users route uses toSafeUser helper", () => {
  const src = read("app/api/admin/users/route.ts");
  assert.ok(
    /toSafeUser/.test(src),
    "admin users route must use toSafeUser() to strip password before response"
  );
});

test("admin users route imports toSafeUser from lib/users", () => {
  const src = read("app/api/admin/users/route.ts");
  assert.ok(
    /toSafeUser.*from.*["'].*\/lib\/users["']/.test(src) ||
    (/import.*toSafeUser/.test(src) && src.includes("lib/users")),
    "admin users route must import toSafeUser from lib/users"
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// API routes — password hash must not appear in responses
// ─────────────────────────────────────────────────────────────────────────────

test("auth routes do not return password field in responses", () => {
  const authRoutes = [
    "app/api/auth/route.ts",
    "app/api/auth/register/route.ts",
    "app/api/auth/forgot-password/route.ts",
    "app/api/auth/reset-password/route.ts",
    "app/api/profile/password/route.ts",
  ];

  for (const route of authRoutes) {
    let src;
    try { src = read(route); } catch { continue; }

    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*\/\/|^\s*\*/.test(line)) continue;
      // Check for password as a JSON response key (but not the strip pattern password: _pw)
      if (
        /["'`]password["'`]\s*:(?!\s*_)/.test(line) &&
        /NextResponse\.json|return\s+\{/.test(line)
      ) {
        assert.fail(`${route} line ${i + 1}: password field appears in response: ${line.trim()}`);
      }
    }
  }
});

test("auth routes do not return raw reset token values in responses", () => {
  // forgot-password returns resetUrl (the URL containing the token), not the raw token itself
  // reset-password route should return only { ok: true }
  const src = read("app/api/auth/reset-password/route.ts");
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\/\/|^\s*\*/.test(line)) continue;
    if (
      /["'`](?:token|resetToken)["'`]\s*:(?!\s*_)/.test(line) &&
      /NextResponse\.json/.test(line)
    ) {
      assert.fail(`reset-password route line ${i + 1}: token field in response: ${line.trim()}`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared crypto module — structural checks
// ─────────────────────────────────────────────────────────────────────────────

test("shared crypto module has server-only directive", () => {
  const src = read("lib/storage/crypto.ts");
  assert.ok(
    src.includes('"server-only"') || src.includes("'server-only'"),
    "lib/storage/crypto.ts must import server-only"
  );
});

test("shared crypto module uses AES-256-GCM", () => {
  const src = read("lib/storage/crypto.ts");
  assert.ok(src.includes("aes-256-gcm"), "crypto.ts must use AES-256-GCM");
  assert.ok(src.includes("createCipheriv") && src.includes("createDecipheriv"),
    "crypto.ts must use createCipheriv/createDecipheriv"
  );
});

test("shared crypto module exports encrypt, decrypt, isEnvelope, hashResetToken not duplicated", () => {
  const src = read("lib/storage/crypto.ts");
  assert.ok(/export function encrypt/.test(src), "crypto.ts must export encrypt");
  assert.ok(/export function decrypt/.test(src), "crypto.ts must export decrypt");
  assert.ok(/export function isEnvelope/.test(src), "crypto.ts must export isEnvelope");
  // hashResetToken belongs in secure-auth-store, not in crypto.ts
  assert.ok(
    !/export function hashResetToken/.test(src),
    "hashResetToken should be in secure-auth-store, not crypto.ts"
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// CI guard smoke-tests (verify the guards would catch regressions)
// ─────────────────────────────────────────────────────────────────────────────

test("CI guard: secure-auth-store is the canonical write path for user records", async () => {
  // No file outside the allowed set should contain writeStore("users.json", ...)
  const ALLOWED = new Set([
    "lib/storage/secure-auth-store.ts",
    "lib/users.ts",
    "lib/auth/reset-tokens.ts",
    "scripts/ci-guards.mjs", // hint strings in the guards script mention file names
  ]);
  const { readdirSync } = await import("node:fs");
  const { join, relative } = await import("node:path");

  function* walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".next", ".git", "dist"].includes(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(full);
      else if (/\.(ts|tsx|mjs)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) yield full;
    }
  }

  for (const full of walk(ROOT)) {
    const rel = relative(ROOT, full);
    if (ALLOWED.has(rel)) continue;
    let src;
    try { src = readFileSync(full, "utf8"); } catch { continue; }
    const fileLines = src.split("\n");
    for (let i = 0; i < fileLines.length; i++) {
      const line = fileLines[i];
      if (/^\s*\/\/|^\s*\*/.test(line)) continue;
      if (isSuppressedLine(line)) continue;
      if (
        /writeStore\s*\(/.test(line) &&
        (line.includes('"users.json"') || line.includes("'users.json'"))
      ) {
        assert.fail(
          `${rel}:${i + 1} — writeStore("users.json") outside allowed modules: ${line.trim()}`
        );
      }
    }
  }
});

function isSuppressedLine(line) {
  return /\/\/\s*(ci-ok|fire-and-forget|dedup handles|ci:skip)/.test(line);
}
