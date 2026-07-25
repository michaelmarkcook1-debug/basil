/**
 * tests/ai-output-budget.test.mjs
 *
 * Guards the output-token budget against the GPT-5.6 reasoning-model trap.
 *
 * The bug: `maxOutputTokens` maps to OpenAI's `max_completion_tokens`, which on
 * REASONING models covers reasoning tokens **plus** the visible answer. At 4_096
 * (fine for the old non-reasoning gpt-4o) an 8-step tool loop spent the whole
 * budget thinking and truncated Ask Basil mid-sentence — while still returning
 * 200, so it looked healthy.
 *
 * The counter-trap: the spend guard reserves worstCaseCostUsd × steps. If that
 * reserved at the raised ceiling it would hold ~$7.68 per chat message and 429
 * the user off their own cap. Hence ceiling (MAX_TOKENS) and budget estimate
 * (RESERVE_OUTPUT_TOKENS) MUST stay decoupled.
 *
 * Static source analysis — no TypeScript compilation required.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");
const cfg = read("lib/ai/model-config.ts");
const pricing = read("lib/ai/pricing.ts");
const chat = read("app/api/chat/route.ts");

/** Parse a numeric table (e.g. MAX_TOKENS) out of model-config. */
function table(name) {
  const start = cfg.indexOf(`export const ${name}`);
  const body = cfg.slice(start, cfg.indexOf("};", start));
  const out = {};
  for (const [, k, v] of body.matchAll(/(\w+):\s*([\d_]+)/g)) out[k] = Number(v.replace(/_/g, ""));
  return out;
}

test("reasoning models get enough headroom to actually answer", () => {
  const max = table("MAX_TOKENS");
  // The interactive tiers must leave room for reasoning tokens AND a real
  // answer. 4_096 is the value that truncated chat mid-sentence.
  assert.ok(max.default > 4_096, `default ceiling (${max.default}) must exceed the 4096 that truncated chat`);
  assert.ok(max.default >= 16_000, `default ceiling (${max.default}) needs reasoning headroom`);
  assert.ok(max.long >= 16_000, `long ceiling (${max.long}) needs reasoning headroom`);
  // ...but stay under what the 5.6 series actually supports (128k).
  for (const [tier, v] of Object.entries(max)) {
    assert.ok(v <= 128_000, `${tier} ceiling (${v}) exceeds the model's 128k max_tokens`);
  }
});

test("spend reservation is DECOUPLED from the output ceiling", () => {
  assert.ok(/export const RESERVE_OUTPUT_TOKENS/.test(cfg),
    "model-config must export RESERVE_OUTPUT_TOKENS");
  assert.ok(/outputTokens: RESERVE_OUTPUT_TOKENS\[kind\]/.test(pricing),
    "worstCaseCostUsd must reserve on RESERVE_OUTPUT_TOKENS, not MAX_TOKENS");
  assert.ok(!/outputTokens: MAX_TOKENS\[kind\]/.test(pricing),
    "reserving at the MAX_TOKENS ceiling holds ~$7.68/message and 429s the user");

  const max = table("MAX_TOKENS");
  const reserve = table("RESERVE_OUTPUT_TOKENS");
  for (const tier of Object.keys(max)) {
    assert.ok(reserve[tier] > 0, `RESERVE_OUTPUT_TOKENS.${tier} must be defined`);
    assert.ok(reserve[tier] <= max[tier],
      `${tier}: reserve (${reserve[tier]}) must not exceed the ceiling (${max[tier]})`);
  }
});

test("chat's function budget fits its tool loop", () => {
  // THE actual truncation cause: maxDuration=60 killed the function mid-stream
  // during a ~20-call, 8-step reasoning tool loop. It still returns 200 (the
  // stream had started), so the only symptom was an answer stopping
  // mid-sentence. Every other AI route already used 300s.
  const m = chat.match(/maxDuration\s*=\s*(\d+)/);
  assert.ok(m, "chat must declare maxDuration");
  assert.ok(Number(m[1]) >= 300,
    `chat maxDuration (${m?.[1]}s) is too small for an 8-step reasoning tool loop — it truncates replies mid-sentence`);
});

test("a truncated chat reply is logged, not swallowed", () => {
  // finishReason "length" returns HTTP 200 — without an explicit log a cut-off
  // answer is indistinguishable from a complete one.
  assert.ok(/onFinish:\s*\(\{[^}]*finishReason/.test(chat),
    "chat onFinish must receive finishReason");
  assert.ok(/finishReason === "length"/.test(chat),
    "chat must explicitly detect the truncation finish reason");
});
