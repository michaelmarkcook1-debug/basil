/**
 * tests/linkedin-backfill.test.mjs
 *
 * The backfill reads mail bodies and writes to contact records, so its
 * safeguards matter more than its yield. A wrong LinkedIn profile on a contact
 * is worse than an empty field: the user has to NOTICE it to fix it, and a
 * plausible-looking wrong profile is exactly what nobody notices.
 *
 * The design rule under test: the backfill decides nothing itself. Every body
 * goes through enrichContactLinkedIn, which owns attribution, so a backfill can
 * never become more permissive than live ingest by drifting apart from it.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");
/** Source with comments removed — scanning raw source for a banned term keeps
 *  matching the comment that explains why it is banned. */
const code = (p) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const backfill = read("lib/contacts/backfill-linkedin.ts");
const enrich = read("lib/contacts/enrich-linkedin.ts");
const route = read("app/api/admin/linkedin-backfill/route.ts");

test("the backfill reuses the ingest safeguards instead of restating them", () => {
  assert.ok(/enrichContactLinkedIn/.test(backfill),
    "attribution must go through the one function that owns it");
  // If the backfill matched or wrote on its own, it could drift more permissive
  // than live ingest without anything failing.
  assert.ok(!/updateUserContactInStore|listUserContacts/.test(backfill),
    "the backfill must not write to the contact store directly");
  assert.ok(!/senderProfileFrom/.test(backfill),
    "it must not extract profiles itself — that is enrichContactLinkedIn's job");
});

test("attribution is by email address, sender only, and never overwrites", () => {
  // Restated here because these are the properties the backfill INHERITS; if
  // they were ever loosened, the backfill would silently apply them at scale.
  assert.ok(/never overwrite|NEVER overwritten|existing value is NEVER/i.test(enrich),
    "an existing value must win over a harvested one");
  assert.ok(/matched by EMAIL ADDRESS only|by email address only/i.test(enrich),
    "names collide; only the address identifies a sender");
  assert.ok(/never creates a contact/i.test(enrich),
    "enrichment fills gaps on existing records, it does not invent people");
});

test("it reads the inbox only", () => {
  assert.ok(/"in:inbox"/.test(backfill),
    "sent mail carries the USER's signature — harvesting it would attribute the " +
    "user's own profile to every person they wrote to");
});

test("it uses the UNSTRIPPED body", () => {
  assert.ok(/getEmailBody/.test(backfill),
    "the events store keeps the stripped body, and stripHtml removes the anchor " +
    "tag carrying the href — the URL only survives in the raw message");
  assert.ok(!/stripHtml/.test(code("lib/contacts/backfill-linkedin.ts")),
    "stripping here would delete the thing being harvested");
});

test("a failed read is counted, never swallowed", () => {
  // "0 applied after silently failing every fetch" and "0 applied because there
  // was nothing to find" are the same number and opposite facts.
  assert.ok(/failed: number/.test(backfill), "failures must be part of the result shape");
  assert.ok(/out\.failed \+= 1/.test(backfill), "the catch must count, not just log");
  assert.ok(/ok: false/.test(route) && /status: 502/.test(route),
    "a Gmail outage must surface as a failure, not an empty successful result");
});

test("the scan is bounded and its truncation is reported", () => {
  assert.ok(/HARD_CAP/.test(backfill), "an unbounded scan is how an integration gets throttled");
  assert.ok(/truncated/.test(backfill),
    "silently stopping at a cap reads as 'that is all there was'");
});

test("the route is admin-gated and costs no AI", () => {
  assert.ok(/ADMIN_API_TOKEN/.test(route) && /Unauthorised/.test(route));
  assert.ok(!/reserveSpend|generateText|streamText/.test(backfill + route),
    "harvesting is string matching; an AI call here would make it fail whenever " +
    "the daily cap is spent, for no benefit");
});
