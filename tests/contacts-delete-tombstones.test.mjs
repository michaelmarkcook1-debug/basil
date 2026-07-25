/**
 * tests/contacts-delete-tombstones.test.mjs
 *
 * Deleting a contact could never stick.
 *
 * loadUserContactsFromServer() unions the server list with "local-only" records,
 * assuming local-but-not-on-server means "hasn't synced yet". That is
 * indistinguishable from "deleted on the server", so every delete was silently
 * resurrected on the next page load — in BOTH directions (server delete → the
 * local copy merges back; local delete → the server copy wins). Observed live:
 * deleting the duplicate "Matthew Paquette" reverted on reload, twice, and the
 * stores had drifted to 399 local vs 392 server.
 *
 * Delete tombstones record the user's INTENT so the union can tell "not yet
 * synced" apart from "deliberately removed". This is a silent failure — the
 * delete looks like it worked and only reverts later — so it gets a guard.
 *
 * Static source analysis — no TypeScript compilation required.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const src = readFileSync(resolve(ROOT, "lib/user-contacts.ts"), "utf8");

/** Body of a named exported function. */
function fn(name) {
  const start = src.indexOf(`export async function ${name}`);
  assert.ok(start > -1, `${name} must exist`);
  return src.slice(start, src.indexOf("\n}", start) + 2);
}

test("a tombstone store exists", () => {
  assert.ok(/DELETED_CONTACTS_KEY\s*=\s*"sage-user-contacts-deleted"/.test(src),
    "a deleted-ids key must exist");
  for (const helper of ["getDeletedContactIds", "addDeletedContactId", "clearDeletedContactId"]) {
    assert.ok(new RegExp(`function ${helper}`).test(src), `${helper}() must exist`);
  }
});

test("deleting records the intent, not just the cache eviction", () => {
  const body = fn("deleteUserContact");
  assert.ok(/addDeletedContactId\(id\)/.test(body),
    "deleteUserContact must tombstone the id — evicting the cache alone lets the next merge resurrect it");
});

test("the merge honours tombstones on BOTH sides of the union", () => {
  const body = fn("loadUserContactsFromServer");
  assert.ok(/getDeletedContactIds\(\)/.test(body), "the merge must read tombstones");
  // local-only is the path that resurrected server-deleted contacts...
  assert.ok(/localOnly\s*=\s*current\.filter\([\s\S]{0,120}?!tombstoned\.has\(c\.id\)/.test(body),
    "local-only records must be filtered by tombstones");
  // ...and the server list is the path that resurrected locally-deleted ones.
  assert.ok(/serverVisible\s*=\s*serverWithProfileProtection\.filter\(\(c\) => !tombstoned\.has\(c\.id\)\)/.test(body),
    "server records must also be filtered, or a local delete is undone by the server copy");
});

test("stranded local-only contacts get reconciled up to the server", () => {
  // addUserContact writes locally then POSTs; a failed POST was never retried,
  // so the contact lived only in that browser forever — invisible on other
  // devices and to every server-side surface. Measured live: 7 stranded records,
  // one a fully curated `verified` contact. The load is the retry.
  const body = fn("loadUserContactsFromServer");
  assert.ok(/import: localOnly/.test(body),
    "local-only records must be pushed back to the server (bulk import) to repair the drift");
  // It must reconcile the TOMBSTONE-FILTERED set, or a delete would be undone.
  const importIdx = body.indexOf("import: localOnly");
  const tombIdx = body.indexOf("!tombstoned.has(c.id)");
  assert.ok(tombIdx > -1 && tombIdx < importIdx,
    "localOnly must already exclude tombstoned ids BEFORE being re-uploaded");
});

test("an explicit re-add lifts the tombstone", () => {
  const body = fn("addUserContact");
  assert.ok(/clearDeletedContactId\(normalised\.id\)/.test(body),
    "adding must clear the tombstone, or a deleted person could never come back");
});
