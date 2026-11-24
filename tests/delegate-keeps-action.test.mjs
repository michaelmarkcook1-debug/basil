/**
 * Delegate must not delete the action (bug found in the 2026-11-24 audit):
 * Delegate wrote a person's name into `owner`, and listActions' clean-up
 * purged any "First Last" owner that wasn't the user.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadTs } from "./_helpers/load-ts.mjs";

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("an owner the user set (delegated, or a hand-made action) is protected", () => {
  const U = loadTs("lib/actions/utils.ts", { "@/lib/types/action": {} }, { tolerateMissing: true });
  assert.equal(U.ownerSetByUser({ delegatedAt: "2026-11-24T10:00:00Z", source: "email" }), true);
  assert.equal(U.ownerSetByUser({ source: "manual" }), true);
  assert.equal(U.ownerSetByUser({ source: "slack" }), false, "an auto-extracted item with someone else's name can still be cleaned up");
});

test("the clean-up skips user-set owners; PATCH records the delegation", () => {
  const store = src("lib/actions/store.ts");
  assert.match(store, /!a\.delegatedAt && \(isGroupOwner\(a\.owner\) \|\| \(!ownerSetByUser\(a\) && isOtherPersonOwner/);
  assert.match(store, /current\.filter\(\(a\) => !isNotMine\(a\)\)/, "the persisted purge uses the same rule");
  const route = src("app/api/actions/[id]/route.ts");
  assert.match(route, /patch\.delegatedTo = o;/);
  assert.match(route, /patch\.delegatedAt = new Date\(\)\.toISOString\(\);/);
});
