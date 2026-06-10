/**
 * tests/storage-wipe-guard.test.mjs
 *
 * Regression guard for the silent data-wipe class of bug in the Blob adapter:
 *   1. A read failure (network, 5xx, corrupt JSON) must NOT be coerced to the
 *      empty fallback — it must throw, so a read-modify-write aborts instead of
 *      durably overwriting the user's real data with nothing.
 *   2. Genuine absence (no blob / 404) MUST still return the fallback.
 *   3. A write that collapses a substantial collection to empty must be refused
 *      by the shrink tripwire unless explicitly allowed.
 *
 * Static source analysis only.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const blobSrc = readFileSync(resolve(ROOT, "lib/storage/adapters/blob.ts"), "utf8");

test("blobReadJson throws (not coerces) on real read errors", () => {
  assert.match(blobSrc, /class BlobReadError/);
  // list/fetch/parse failures must throw BlobReadError.
  assert.ok(
    (blobSrc.match(/throw new BlobReadError/g) ?? []).length >= 3,
    "list, fetch, and JSON-parse failures must each throw BlobReadError"
  );
  // The old blanket `catch { return fallback; }` swallow must be gone.
  assert.doesNotMatch(
    blobSrc,
    /catch\s*\{\s*\n?\s*return fallback;\s*\n?\s*\}/,
    "blobReadJson must not swallow all errors into the empty fallback"
  );
});

test("blobReadJson still returns fallback for genuine absence", () => {
  assert.match(blobSrc, /if \(!url\) return fallback/, "missing blob → fallback");
  assert.match(blobSrc, /res\.status === 404[\s\S]{0,60}return fallback/, "404 → fallback");
});

test("blobWriteJson has a shrink tripwire", () => {
  assert.match(blobSrc, /class BlobShrinkGuardError/);
  assert.match(blobSrc, /SHRINK_GUARD_MIN/);
  assert.match(blobSrc, /allowShrink/, "must allow an explicit intentional-clear bypass");
  assert.match(blobSrc, /throw new BlobShrinkGuardError/);
});

test("writeStore threads allowShrink through to the adapter", () => {
  const persistentSrc = readFileSync(resolve(ROOT, "lib/storage/persistent.ts"), "utf8");
  assert.match(persistentSrc, /allowShrink/, "writeStore options must carry allowShrink");
});
