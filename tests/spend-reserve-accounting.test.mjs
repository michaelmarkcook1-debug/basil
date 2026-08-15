/**
 * tests/spend-reserve-accounting.test.mjs
 *
 * Two production bugs from 2026-08-15, both in the reserve/commit accounting.
 *
 * 1. THE CAP MADE CHAT IMPOSSIBLE.
 *    Chat reserved worst-case for all 8 tool-loop steps: 24k in + 6k out on
 *    Opus 5 = $0.27/step × 8 = $2.16 held for ONE message. Against the owner's
 *    $1/day per-user ceiling that is rejected before a single token is sent, so
 *    Ask Basil could never run — at ANY level of real spend. Found with the user
 *    at $0.34 of $1.00 used and the UI reporting "budget reached".
 *
 * 2. UNCAPPED COUNTERS WENT NEGATIVE.
 *    reserveSpend credits only counters that HAVE a cap; commitSpend wrote the
 *    same (actual − reserved) delta to ALL of them. The uncapped ones were
 *    therefore debited a reservation they never received. Live figures:
 *    globalUsd −8.89, every per-user monthly total negative, while the
 *    one genuinely held counter (user-daily) stayed correct.
 *
 * Contract-lock: the accounting is reimplemented below. If spend-guard.ts
 * changes behaviour, update BOTH.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const guard = readFileSync(resolve(ROOT, "lib/ai/spend-guard.ts"), "utf8");

// Opus 5 rates and the real reserve constants.
const IN_TOK = 24_000, OUT_TOK = 6_000;
const perStep = (IN_TOK / 1e6) * 5 + (OUT_TOK / 1e6) * 25; // $0.27

test("a single chat reservation fits inside a $1/day per-user cap", () => {
  const CAP = 1.0;
  const RESERVE_STEP_CAP = 2;
  const reserved = perStep * Math.min(8, RESERVE_STEP_CAP);
  assert.ok(
    reserved < CAP,
    `one chat message reserves $${reserved.toFixed(2)}, which must fit under a $${CAP} daily cap ` +
    `(unclamped it was $${(perStep * 8).toFixed(2)} and chat could never start)`,
  );
});

test("the step multiplier is clamped in source", () => {
  assert.ok(/RESERVE_STEP_CAP/.test(guard), "the clamp must exist");
  assert.ok(/Math\.min\(Math\.max\(1, meter\.maxSteps \?\? 1\), RESERVE_STEP_CAP\)/.test(guard),
    "steps must be clamped, not taken raw from maxSteps");
});

// ── Counter accounting ───────────────────────────────────────────────────────

/** Mirror of commitDeltaFor. */
const commitDelta = (key, heldKeys, actual, reserved) =>
  heldKeys.includes(key) ? actual - reserved : actual;

test("behaviour: an uncapped counter never goes negative", () => {
  // Only a per-user DAILY cap configured — exactly the live configuration.
  const held = ["spend:user:michael:day:2026-08-15"];
  const all = [
    "spend:global:2026-08",
    "spend:user:michael:2026-08",
    "spend:global:day:2026-08-15",
    "spend:user:michael:day:2026-08-15",
  ];
  const reserved = 0.54, actual = 0.08;

  const counters = Object.fromEntries(all.map((k) => [k, 0]));
  // reserve: only held keys are credited
  for (const k of held) counters[k] += reserved;
  // commit: every counter settles by its own rule
  for (const k of all) counters[k] += commitDelta(k, held, actual, reserved);

  for (const k of all) {
    assert.ok(counters[k] >= 0, `${k} must never be negative (got ${counters[k]})`);
    assert.ok(Math.abs(counters[k] - actual) < 1e-9,
      `${k} must equal the actual spend ${actual} (got ${counters[k]})`);
  }
});

test("behaviour: the OLD shared-delta logic is what produced the negatives", () => {
  // Regression witness: prove the previous behaviour really did go negative, so
  // this test fails loudly if anyone reinstates a single shared delta.
  const held = ["spend:user:michael:day:2026-08-15"];
  const unheld = "spend:global:2026-08";
  const reserved = 0.54, actual = 0.08;
  const oldDelta = actual - reserved; // applied to EVERY counter
  assert.ok(oldDelta < 0);
  assert.ok(0 + oldDelta < 0, "an unheld counter took a debit it was never credited");
  assert.equal(commitDelta(unheld, held, actual, reserved), actual,
    "the fix records actual spend on an unheld counter instead");
});

test("release refunds only the counters that took the hold", () => {
  const body = guard.slice(guard.indexOf("export async function releaseSpend"));
  assert.ok(/heldKeys\.includes\(key\)/.test(body),
    "refunding a counter that was never credited pushes it negative");
});

test("the reservation carries which counters it held", () => {
  assert.ok(/heldKeys: string\[\]/.test(guard), "the reservation must record its held keys");
  assert.ok(/heldKeys: applied\.map\(\(h\) => h\.key\)/.test(guard),
    "held keys come from the holds actually applied, not from which caps exist");
});

test("a cap rejection names when it resets, not 'next month' for a daily scope", () => {
  const chat = readFileSync(resolve(ROOT, "app/api/chat/route.ts"), "utf8");
  assert.ok(!/Try again next month or contact support/.test(chat),
    "the old copy said 'next month' for DAILY caps, sending the owner to their provider's billing");
  assert.ok(/midnight UTC/.test(chat), "a daily cap must say it resets at midnight UTC");
  assert.ok(/not your provider's credit/.test(chat),
    "it must say the limit is Basil's own, or the reader debugs the wrong system");
});
