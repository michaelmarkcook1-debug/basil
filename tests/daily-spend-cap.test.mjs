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
  // The keys now come from the shared counterKeysFor(reservation) list (see the
  // drift test below), so what matters here is that NEITHER settle path
  // recomputes the window — a call reserved at 23:59 must settle on that day.
  for (const fn of ["commitSpend", "releaseSpend"]) {
    const at = guard.indexOf(`export async function ${fn}`);
    const body = guard.slice(at, at + 900);
    assert.ok(/counterKeysFor\(reservation\)/.test(body),
      `${fn} must settle via the reservation's own keys`);
    assert.ok(!/currentDay\(\)/.test(body) && !/currentPeriod\(\)/.test(body),
      `${fn} must NOT recompute the window — that misfiles a midnight-straddling call`);
  }
});

test("one unwind path returns EVERY hold taken", () => {
  // With four ceilings, hand-written rollback needs a branch per combination of
  // "which earlier holds are applied" — that grows combinatorially and is where
  // a leaked reservation hides. A leak is silent and permanent: the budget just
  // quietly shrinks. So: one ordered list, one unwind.
  const body = guard.slice(guard.indexOf("export async function reserveSpend"));
  assert.ok(/const unwind = async \(\)/.test(body), "a single unwind helper must exist");
  assert.ok(/applied\.push\(h\)/.test(body), "each taken hold must be recorded");
  // Pushed BEFORE the cap check, so the hold that triggered the rejection is
  // itself returned — otherwise every rejection leaks exactly one hold.
  const pushIdx = body.indexOf("applied.push(h)");
  const checkIdx = body.indexOf("if (value > h.cap)");
  assert.ok(pushIdx > -1 && checkIdx > -1 && pushIdx < checkIdx,
    "the hold must be recorded before the check, or the rejecting hold is never returned");
  // Both the cap-rejection path and the store-error path must unwind.
  assert.ok((body.match(/await unwind\(\)/g) || []).length >= 2,
    "cap rejections AND store errors must both unwind");
});

test("per-user daily cap exists and is checked first", () => {
  assert.ok(/AI_PER_USER_DAILY_USD/.test(guard), "per-user daily ceiling must be configurable");
  assert.ok(/spend:user:\$\{username\.toLowerCase\(\)\}:day:/.test(guard),
    "per-user daily counter needs its own key, lower-cased like userKey");
  const body = guard.slice(guard.indexOf("export async function reserveSpend"));
  const userDaily = body.indexOf("userDailyKey(meter.username, day)");
  const globalDaily = body.indexOf("dailyKey(day)");
  assert.ok(userDaily > -1 && userDaily < globalDaily,
    "the per-user daily hold is the tightest bound for one caller — check it first");
});

test("commit and release share ONE key list, so they cannot drift", () => {
  assert.ok(/function counterKeysFor/.test(guard),
    "a single source of truth for which counters a reservation touches");
  for (const fn of ["commitSpend", "releaseSpend"]) {
    const at = guard.indexOf(`export async function ${fn}`);
    const body = guard.slice(at, at + 700);
    assert.ok(/counterKeysFor\(reservation\)/.test(body),
      `${fn} must use the shared list — a counter incremented on reserve but missed on release leaks budget permanently`);
  }
  // And that list must be keyed off the reservation's own window.
  const keys = guard.slice(guard.indexOf("function counterKeysFor"), guard.indexOf("// ── Reserve"));
  assert.ok(/r\.day/.test(keys) && /r\.period/.test(keys), "settle against the reserved window");
  assert.ok(!/currentDay\(\)/.test(keys), "never currentDay() — a midnight-straddling call would misfile");
});

test("behaviour: per-user caps are independent, not a shared pool", () => {
  const CAP = 1.0;
  const counters = { michael: 0, andrew: 0 };
  const reserve = (user, worst) => {
    counters[user] += worst;
    if (counters[user] > CAP) { counters[user] -= worst; return false; }
    return true;
  };
  // michael exhausts his day
  let n = 0;
  while (reserve("michael", 0.1)) n++;
  assert.equal(reserve("michael", 0.1), false, "michael is capped");
  assert.equal(reserve("andrew", 0.1), true,
    "andrew must be unaffected — a per-user cap is not a shared pool one user can starve");
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
