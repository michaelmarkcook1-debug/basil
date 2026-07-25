/**
 * tests/ai-fallback-budget.test.mjs
 *
 * Regression guard for the 504-on-slow-primary bug. Two defects, one symptom:
 *
 *   1. A single 22s per-attempt abort meant primary(22s) + fallback(22s) = 44s,
 *      which blows past a 30s route budget → guaranteed 504 whenever the first
 *      attempt ran even slightly slow.
 *   2. With the gateway disabled the primary IS a direct provider, yet the
 *      fallback chain retried that SAME provider first — a wasted attempt that
 *      burned the remaining budget before the cross-provider fallback could run.
 *
 * Fixes asserted here: tier-aware per-attempt timeout, and skipping the
 * redundant same-provider fallback so a genuine cross-provider retry fits the
 * route budget.
 *
 * Static source analysis — no TypeScript compilation required.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const gen = readFileSync(resolve(ROOT, "lib/ai/generate.ts"), "utf8");
const testBrain = readFileSync(resolve(ROOT, "app/api/ai/test-brain/route.ts"), "utf8");
const actionsClassify = readFileSync(resolve(ROOT, "app/api/actions/classify/route.ts"), "utf8");

/** Per-tier attempt ceiling (ms) parsed out of the table in generate.ts. */
function ceiling(tier) {
  const table = gen.slice(gen.indexOf("ATTEMPT_TIMEOUT_BY_KIND"), gen.indexOf("function attemptTimeoutMs"));
  const m = table.match(new RegExp(`${tier}:\\s*([\\d_]+)`));
  return Number(m?.[1]?.replace(/_/g, ""));
}
/** A route's maxDuration (ms). */
function budget(src) {
  const m = src.match(/maxDuration\s*=\s*(\d+)/);
  return Number(m?.[1]) * 1000;
}

test("per-attempt timeout is tier-aware, not a single fixed ceiling", () => {
  assert.ok(/ATTEMPT_TIMEOUT_BY_KIND/.test(gen),
    "generate.ts must define a per-tier timeout table");
  assert.ok(/attemptTimeoutMs\(kind\)/.test(gen) || /attemptSignal\(kind/.test(gen),
    "attemptSignal must take the tier so the ceiling varies by kind");
});

// Assert against the REAL route budgets rather than a hardcoded number, so
// raising/lowering a route's maxDuration can't silently invalidate the ceiling.
test("two fast-tier attempts fit inside the tightest fast-tier route (test-brain)", () => {
  const fast = ceiling("fast");
  const routeBudget = budget(testBrain);
  assert.ok(fast > 0 && routeBudget > 0, "fast ceiling and test-brain maxDuration must both parse");
  assert.ok(fast * 2 < routeBudget,
    `two fast attempts (${fast}×2=${fast * 2}ms) must fit test-brain's ${routeBudget}ms budget`);
});

test("two balanced-tier attempts fit inside the tightest balanced-tier route (actions/classify)", () => {
  const balanced = ceiling("balanced");
  const routeBudget = budget(actionsClassify);
  assert.ok(balanced > 0 && routeBudget > 0, "balanced ceiling and actions/classify maxDuration must both parse");
  assert.ok(balanced * 2 < routeBudget,
    `two balanced attempts (${balanced}×2=${balanced * 2}ms) must fit actions/classify's ${routeBudget}ms budget`);
});

test("bulk tiers keep a generous ceiling so long generations aren't killed", () => {
  assert.ok(ceiling("default") >= 45_000, `default tier ceiling (${ceiling("default")}) must stay generous`);
  assert.ok(ceiling("long") >= 60_000, `long tier ceiling (${ceiling("long")}) must stay generous`);
});

test("redundant same-provider fallback is skipped when the primary is direct", () => {
  assert.ok(/PROVIDER_MODE === "openai_direct"/.test(gen) && /fallbacks = \[anthropic\]/.test(gen),
    "openai-direct primary must fall back to Anthropic ONLY (no redundant OpenAI retry)");
  assert.ok(/PROVIDER_MODE === "anthropic_direct"/.test(gen) && /fallbacks = \[openai\]/.test(gen),
    "anthropic-direct primary must fall back to OpenAI ONLY");
  // Gateway primary still tries both distinct direct providers.
  assert.ok(/preferOpenAI\(\) \? \[openai, anthropic\] : \[anthropic, openai\]/.test(gen),
    "gateway/explicit-model primary must still try both direct providers");
});

test("test-brain route budget accommodates the fast-tier fallback chain", () => {
  const m = testBrain.match(/maxDuration\s*=\s*(\d+)/);
  assert.ok(m, "test-brain must declare maxDuration");
  assert.ok(Number(m[1]) >= 30, `test-brain maxDuration (${m?.[1]}) must fit two fast attempts + headroom`);
});
