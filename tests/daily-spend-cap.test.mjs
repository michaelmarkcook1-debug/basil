/**
 * tests/daily-spend-cap.test.mjs
 *
 * A DAILY spend ceiling, because a monthly one cannot express "$1 a day".
 *
 * AI_GLOBAL_MONTHLY_USD=30 permits burning the entire month's allowance before
 * lunch and only notices once it is gone. The failure mode this codebase has
 * already produced twice — categorisation on a flagship model, and speculative
 * drafts written for mail nobody opened — is "quietly expensive EVERY day",
 * which a daily ceiling stops within hours instead of weeks.
 *
 * Contract-lock (house pattern): the reserve/commit/release accounting is
 * reimplemented below. If spend-guard.ts changes behaviour, update BOTH.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const guard = readFileSync(resolve(ROOT, "lib/ai/spend-guard.ts"), "utf8");
const log = readFileSync(resolve(ROOT, "lib/ai/spend-log.ts"), "utf8");

test("a daily cap exists, with its own env var and counter namespace", () => {
  assert.ok(/AI_GLOBAL_DAILY_USD/.test(guard), "the daily ceiling must be configurable");
  assert.ok(/spend:global:day:/.test(guard),
    "the daily counter needs its own namespace — a YYYY-MM-DD period would otherwise collide with the monthly key");
  assert.ok(/export function currentDay/.test(log) && /export function secondsUntilDayEnd/.test(log),
    "day-window helpers must exist for the counter key and Retry-After");
});

test("the daily ceiling is checked BEFORE the looser monthly ones", () => {
  const body = guard.slice(guard.indexOf("export async function reserveSpend"));
  const daily = body.indexOf("dailyKey(day)");
  const global = body.indexOf("globalKey(period)");
  assert.ok(daily > -1 && global > -1 && daily < global,
    "rejecting on the tightest bound first avoids touching the other counters at all");
});

test("commit and release reconcile the reservation's OWN day", () => {
  // Recomputing the day at commit time would misfile a call that straddled
  // midnight, crediting the refund to tomorrow and leaving yesterday
  // permanently over-counted — the counter would drift upward every night.
  assert.ok(/day: string/.test(guard), "the reservation must carry its day");
  for (const fn of ["commitSpend", "releaseSpend"]) {
    const body = guard.slice(guard.indexOf(`export async function ${fn}`), guard.indexOf(`export async function ${fn}`) + 900);
    assert.ok(/dailyKey\(reservation\.day\)/.test(body),
      `${fn} must adjust dailyKey(reservation.day), never currentDay()`);
  }
});

test("every rejection path unwinds the daily hold", () => {
  // A reservation that is taken and then rejected by a LATER cap must not leak,
  // or the day's budget silently shrinks with every rejected call.
  const body = guard.slice(guard.indexOf("export async function reserveSpend"));
  const rollbacks = (body.match(/incrCounter\(dailyKey\(day\), -worst/g) || []).length;
  assert.ok(rollbacks >= 3,
    `expected daily rollbacks on the daily/global/user rejection paths and the store-error path, found ${rollbacks}`);
});

test("observe-only still applies when ONLY a daily cap is set", () => {
  const body = guard.slice(guard.indexOf("export async function reserveSpend"));
  assert.ok(/gc === null && uc === null && dc === null/.test(body),
    "a daily-only configuration must still reserve — the early return must account for it");
});

test("the summary reports today against today's ceiling", () => {
  assert.ok(/dailyUsd/.test(guard) && /dailyCapUsd/.test(guard),
    "month-to-date cannot answer 'is it running away right now'");
});

// ── Behaviour: the accounting ────────────────────────────────────────────────

test("behaviour: the cap bounds a runaway to roughly one day's budget", () => {
  const CAP = 1.0;
  let counter = 0;
  const reserve = (worst) => {
    counter += worst;
    if (counter > CAP) { counter -= worst; return false; } // rejected + rolled back
    return true;
  };
  const commit = (worst, actual) => { counter += actual - worst; };

  let calls = 0, spent = 0;
  // A regression that tries to make 10,000 expensive calls in a day.
  for (let i = 0; i < 10_000; i++) {
    const worst = 0.10, actual = 0.02;
    if (!reserve(worst)) break;
    commit(worst, actual);
    calls++; spent += actual;
  }
  assert.ok(calls < 10_000, "the runaway must be stopped, not merely recorded");
  assert.ok(spent <= CAP + 0.1, `spend stayed within the day's budget (${spent.toFixed(2)})`);
});

test("behaviour: a rejected reservation does not consume budget", () => {
  const CAP = 1.0;
  let counter = 0.99;
  const worst = 0.10;
  counter += worst;
  const rejected = counter > CAP;
  if (rejected) counter -= worst; // roll back
  assert.equal(rejected, true);
  assert.ok(Math.abs(counter - 0.99) < 1e-9,
    "a rejection must leave the counter exactly as it was, or the budget bleeds away");
});
