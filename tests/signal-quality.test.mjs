/**
 * tests/signal-quality.test.mjs
 *
 * Guards two signal-quality rules from live false positives (2026-07-19):
 *
 * 1. "Stakeholder has gone quiet" fired for MAILING LISTS. The suggester mints
 *    contacts from recurring senders (GlobalData Technology, IIAR, newsletter
 *    authors); the delta engine then treated a marketing blast going quiet as a
 *    relationship signal — and, because key-contact ranking is purely
 *    recency-based, a weekly newsletter could even claim a "key contact" slot.
 *
 * 2. "Reply to X" fired for mail the user was merely Cc'd on. Inbox membership
 *    was the only gate, so invitations opening "Hi Rohan…" and prospects
 *    thanking Ed produced reply prompts for mail that never addressed the user.
 *
 * Static source analysis — no TypeScript compilation required.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

const compute = read("lib/delta/compute.ts");
const detect = read("lib/followups/detect.ts");
const gmail = read("lib/google/gmail.ts");

test("uncurated auto-added contacts produce NO relationship signals", () => {
  // The gate must sit INSIDE the contact loop, before any event emission.
  const loop = compute.slice(compute.indexOf("for (const c of sorted)"));
  const gate = loop.indexOf('c.status === "pending" && (c.tags ?? []).includes("auto-added")');
  const firstEvent = loop.indexOf("events.push");
  assert.ok(gate > -1, "the curated-contact gate must exist in the contact loop");
  assert.ok(firstEvent > -1 && gate < firstEvent,
    "the gate must run before ANY relationship event is emitted (tone, engaged, silent)");
});

test("newsletters cannot claim key-contact slots", () => {
  const fn = compute.slice(compute.indexOf("function buildKeyContactSet"));
  const body = fn.slice(0, fn.indexOf("\n}") + 2);
  assert.ok(/auto-added/.test(body),
    "buildKeyContactSet must exclude uncurated auto-added contacts from recency ranking");
});

test("reply prompts require the user to be an actual recipient", () => {
  assert.ok(/const inTo = \[\.\.\.selfEmails\]\.some/.test(detect),
    "the gmail follow-up filter must check the To header for a self address");
  // The Cc escape hatch: named call-outs still surface.
  assert.ok(/selfFirstNames\.some\(\(n\) => snip\.includes\(n\)\)/.test(detect),
    "Cc-only mail must be kept ONLY when the snippet names the user");
  // And the To header must actually be available to check.
  assert.ok(/metadataHeaders: \["From", "To", "Subject", "Date"\]/.test(gmail),
    "getRecentEmails must fetch the To header");
});
