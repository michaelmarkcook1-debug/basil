/**
 * tests/contacts-suggest-dedupe.test.mjs
 *
 * THE DUPLICATE FACTORY.
 *
 * /api/contacts/suggest is supposed to "de-dupe against existing contacts". It
 * called findContactByName(name) with NO `extra` argument — and that helper
 * searches `extra` then sampleContacts(). sampleContacts() is gated behind
 * SHOW_SAMPLE_CONTACTS and returns [] in production, so the de-dupe check
 * matched NOTHING, ever. The strip therefore kept offering people who are
 * already contacts (measured live: 7 of 12 — Ed Baum, Malcolm Frank, Isaac
 * Frank, Christopher Walton, Euan Davis, Carter Lusher, GlobalData Technology),
 * and accepting one minted a duplicate. That is how "Matthew Paquette" appeared
 * next to the real "Matt Paquette", and how 375 auto-added contacts accumulated.
 *
 * Static source analysis — no TypeScript compilation required.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

const suggest = read("app/api/contacts/suggest/route.ts");
const lookup = read("lib/contacts-lookup.ts");
const contactsData = read("lib/contacts-data.ts");

test("sampleContacts() really is empty in production — so it cannot be the de-dupe source", () => {
  const fn = contactsData.slice(contactsData.indexOf("export function sampleContacts"));
  const body = fn.slice(0, fn.indexOf("\n}") + 2);
  assert.ok(/SHOW_SAMPLE_CONTACTS/.test(body) && /\?\s*contacts\s*:\s*\[\]/.test(body),
    "sampleContacts is env-gated and returns [] unless explicitly enabled");
});

test("suggest de-dupes against the user's REAL contacts", () => {
  assert.ok(/listUserContacts\(username\)/.test(suggest),
    "suggest must load the user's actual contacts — the whole bug was that it never did");
  assert.ok(/findContactByName\(name, knownContacts\)/.test(suggest),
    "email-sender de-dupe must pass the real contacts as `extra`");
  assert.ok(/findContactByName\(m\.author, knownContacts\)/.test(suggest),
    "slack-author de-dupe must pass the real contacts as `extra`");
  assert.ok(/findContactByEmail\(email, knownContacts\)/.test(suggest),
    "email de-dupe must check real contacts, not just sampleContacts()");
});

test("no de-dupe check silently falls back to the empty sample list", () => {
  assert.ok(!/findContactByName\([^,)]*\)\s*\)/.test(suggest),
    "findContactByName must never be called without `extra` — that only searches the empty sample list");
  assert.ok(!/sampleContacts\(\)\.some/.test(suggest),
    "de-duping via sampleContacts() is a no-op in production");
});

test("the '(via X)' relay suffix is stripped from sender names", () => {
  // Google Docs comment mail arrives as "Malcolm Frank (via Google Docs)". That
  // matches no existing contact, so it sailed past the de-dupe and minted a
  // duplicate beside the real Malcolm Frank — one such twin per relay product.
  assert.ok(/function stripRelaySuffix/.test(suggest), "a relay-suffix stripper must exist");
  assert.ok(/\\s\*\\\(via \[\^\)\]\*\\\)\\s\*\$/.test(suggest) || /\(via \[\^\)\]\*\\\)/.test(suggest),
    "it must strip a trailing '(via …)' group");
  // ...and it must actually be applied where the sender name is parsed.
  const fn = suggest.slice(suggest.indexOf("function parseFromHeader"));
  const body = fn.slice(0, fn.indexOf("\n}") + 2);
  assert.ok(/stripRelaySuffix\(/.test(body),
    "parseFromHeader must apply stripRelaySuffix, or the suffixed name still creates a twin");
});

test("the lookup helper still matches nicknames (Matt ↔ Matthew)", () => {
  // matches() has a first-name rule; it is what lets an existing "Matt Paquette"
  // suppress a "Matthew Paquette" suggestion once real contacts are passed in.
  assert.ok(/c\.name\.split\(" "\)\[0\]/.test(lookup),
    "matches() must retain first-name matching so nickname variants are caught");
});
