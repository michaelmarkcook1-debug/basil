/**
 * The elastic spend hold (2026-09-26), against the real spend guard.
 *
 * Opus 5.5 at the new worst case: 48k in × $4/M + 6k out × $20/M = $0.312 a
 * step, so the full three-step hold is $0.936. Against the $1/day per-user cap
 * the code comments record for the owner, the full hold fits only on a fresh
 * day; after that the guard must fall back to one step rather than refuse.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./_helpers/load-ts.mjs";

const pricing = loadTs("lib/ai/pricing.ts", { "./model-config": { RESERVE_OUTPUT_TOKENS: { fast: 2_000, balanced: 3_000, default: 6_000, long: 8_000 } } });
const ONE = pricing.worstCaseCostUsd("default", "opus55");

function guard(counters, env = { AI_PER_USER_DAILY_USD: "1" }) {
  return loadTs("lib/ai/spend-guard.ts", {
    "./pricing": pricing,
    "@/lib/storage/counter": { incrCounter: async (key, delta) => { counters.set(key, +((counters.get(key) ?? 0) + delta).toFixed(6)); return { value: counters.get(key) }; } },
    "./spend-log": { currentPeriod: () => "2026-09", currentDay: () => "2026-09-26", secondsUntilPeriodEnd: () => 100, secondsUntilDayEnd: () => 10, appendSpendEvent: async () => {} },
  }, env);
}
const meter = { username: "u", feature: "chat", family: "opus55", maxSteps: 8 };
const dailyKey = (m) => [...m.keys()].find((k) => k.includes("u") && k.includes("2026-09-26"));

test("a step on Opus 5.5 is held at $0.312 with the new 48k worst-case input", () => {
  assert.ok(Math.abs(ONE - 0.312) < 1e-9, `one step = ${ONE}`);
});

test("fresh day: the full three-step hold fits under $1 and the loop gets three steps", async () => {
  const counters = new Map();
  const r = await guard(counters).reserveSpend(meter, "default");
  assert.equal(r.heldSteps, 3);
  assert.ok(Math.abs(r.reservedUsd - 3 * ONE) < 1e-9);
});

test("part-used day: no room for three steps, so it falls back to one — and nothing leaks", async () => {
  const counters = new Map();
  const g = guard(counters);
  await g.reserveSpend(meter, "default");                 // take a hold to create the key
  const k = dailyKey(counters); counters.set(k, 0.2);      // $0.20 already spent today
  const r = await g.reserveSpend(meter, "default");
  assert.equal(r.heldSteps, 1, "3 steps would be $1.136 > $1 — fall back");
  assert.ok(Math.abs(counters.get(k) - (0.2 + ONE)) < 1e-6, `counter ${counters.get(k)}: the failed 3-step attempt must be fully returned`);
});

test("nearly spent: not even one step fits, so the request is refused as before", async () => {
  const counters = new Map();
  const g = guard(counters);
  await g.reserveSpend(meter, "default");
  const k = dailyKey(counters); counters.set(k, 0.8);
  await assert.rejects(g.reserveSpend(meter, "default"), (e) => e instanceof g.SpendCapError && e.scope === "user-daily");
  assert.ok(Math.abs(counters.get(k) - 0.8) < 1e-6, "a refusal leaves the counter untouched");
});

test("a single-step caller is unaffected: it holds one step, never three", async () => {
  const r = await guard(new Map()).reserveSpend({ ...meter, maxSteps: 1 }, "default");
  assert.equal(r.heldSteps, 1);
});

test("no cap configured: still observe-only — no hold, no ceiling", async () => {
  const r = await guard(new Map(), {}).reserveSpend(meter, "default");
  assert.equal(r.reservedUsd, 0);
});
