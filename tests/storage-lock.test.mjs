/**
 * tests/storage-lock.test.mjs
 *
 * Regression guard for the cross-instance clobber fix:
 *   - the named read-modify-write lock delegates to the Redis-backed lock so it
 *     holds across Vercel instances (not just in-process);
 *   - all user-record mutations go through the locked mutateUserRecords (so two
 *     concurrent signups can't erase each other).
 *
 * Static source analysis only.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (rel) => readFileSync(resolve(ROOT, rel), "utf8");

test("storage/lock uses an atomic Redis acquire", () => {
  const src = read("lib/storage/lock.ts");
  assert.match(src, /nx:\s*true/, "must SET NX for an atomic acquire");
  assert.match(src, /export async function withLock/);
});

test("events/lock delegates to the cross-instance lock", () => {
  const src = read("lib/events/lock.ts");
  assert.match(src, /export\s*\{\s*withLock\s*\}\s*from\s*["']@\/lib\/storage\/lock["']/);
});

test("secure-auth-store exposes a locked mutateUserRecords", () => {
  const src = read("lib/storage/secure-auth-store.ts");
  assert.match(src, /export async function mutateUserRecords/);
  assert.match(src, /withLock\(/, "the mutation must run under the lock");
});

test("user mutations go through mutateUserRecords, not raw writeUserRecords", () => {
  const src = read("lib/users.ts");
  // The risky read-then-writeUserRecords pattern must be gone from the mutators.
  assert.doesNotMatch(
    src,
    /await writeUserRecords\(/,
    "createUser/updateUser/etc must use mutateUserRecords, not call writeUserRecords directly"
  );
  assert.match(src, /mutateUserRecords\(/);
});

test("persistent exposes atomic updateStore", () => {
  assert.match(read("lib/storage/persistent.ts"), /export async function updateStore/);
  assert.match(read("lib/storage/user-store.ts"), /export async function updateUserStore/);
});
