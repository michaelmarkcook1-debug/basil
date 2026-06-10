/**
 * tests/oauth-csrf.test.mjs
 *
 * Regression guard: every redirect-based OAuth provider must mint a CSRF state
 * on initiation and verify it on callback. Without it, an attacker can link
 * their own account to a victim's Basil session (login CSRF / account linking).
 *
 * Static source analysis only.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (rel) => readFileSync(resolve(ROOT, rel), "utf8");

const PROVIDERS = [
  { name: "google", init: "app/api/auth/google/route.ts", cb: "app/api/auth/google/callback/route.ts" },
  { name: "microsoft", init: "app/api/auth/microsoft/route.ts", cb: "app/api/auth/microsoft/callback/route.ts" },
  { name: "zoom", init: "app/api/auth/zoom/route.ts", cb: "app/api/auth/zoom/callback/route.ts" },
  { name: "slack", init: "app/api/auth/slack/oauth/route.ts", cb: "app/api/auth/slack/callback/route.ts" },
];

for (const p of PROVIDERS) {
  test(`${p.name}: initiation mints OAuth state`, () => {
    assert.match(read(p.init), /buildOAuthState\(["']/, `${p.init} must call buildOAuthState`);
  });
  test(`${p.name}: callback verifies OAuth state`, () => {
    assert.match(read(p.cb), /verifyOAuthState\(["']/, `${p.cb} must call verifyOAuthState`);
  });
}

test("oauth-state helper exists with the expected API", () => {
  const src = read("lib/auth/oauth-state.ts");
  assert.match(src, /export function buildOAuthState/);
  assert.match(src, /export function verifyOAuthState/);
  assert.match(src, /timingSafeEqual/, "must compare in constant time");
});
