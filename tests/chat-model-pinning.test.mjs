/**
 * tests/chat-model-pinning.test.mjs
 *
 * Guards the fix for "Ask Basil isn't working / still isn't Sonnet 5".
 *
 * The bug: the assistant resolved its model via getTextModel(), which honours
 * the GLOBAL AI_PREFER_OPENAI switch. That switch is set in production, so
 * Ask Basil ran on OpenAI (gpt-4o) — which was erroring — and the Sonnet 5
 * model IDs never applied to it at all. Worse, AI_PREFER_OPENAI is a SENSITIVE
 * env var, so `vercel env pull` shows it as "" and it reads as unset.
 *
 * The fix: user-facing assistant surfaces resolve via getChatModel(), which
 * pins to Claude (gateway, else Anthropic direct) regardless of the global
 * bulk-provider preference.
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
const webChat = read("app/api/chat/route.ts");
const mobileChat = read("app/api/chat/mobile/route.ts");
const stig = read("lib/stig/engine.ts");
const pricing = read("lib/ai/pricing.ts");

test("getChatModel exists and does NOT consult the global OpenAI preference or tier", () => {
  assert.ok(/export function getChatModel/.test(cfg), "model-config must export getChatModel()");
  const fn = cfg.slice(cfg.indexOf("export function getChatModel"));
  const body = fn.slice(0, fn.indexOf("\n}") + 2);
  assert.ok(!/preferOpenAI\(\)/.test(body),
    "getChatModel must NOT branch on preferOpenAI() — a global bulk switch must not pick the assistant's model");
  assert.ok(!/GATEWAY_MODEL_IDS\[kind\]|OPENAI_MODEL_IDS\[kind\]/.test(body),
    "getChatModel must NOT resolve by tier — plan down-tiering would silently swap the pinned model");
});

test("every user-facing assistant surface resolves via getChatModel", () => {
  for (const [name, src] of [["web chat", webChat], ["mobile chat", mobileChat], ["stig/voice engine", stig]]) {
    assert.ok(/getChatModel\(/.test(src), `${name} must call getChatModel()`);
    assert.ok(!/model:\s*getTextModel\(/.test(src),
      `${name} must NOT resolve its model via getTextModel() (honours AI_PREFER_OPENAI + tier)`);
  }
});

test("assistant is pinned to Opus 5 in BOTH id forms (gateway vs direct)", () => {
  // OWNER POLICY 2026-07-23: the assistant runs Claude Opus 5; GPT-5.6 Sol is
  // now only its fallback. The id FORMS differ and mixing them 404s.
  assert.ok(/CHAT_MODEL_GATEWAY_ID\s*=\s*process\.env\.\w+\s*\?\?\s*"anthropic\/claude-opus-5"/.test(cfg),
    'gateway id must default to "anthropic/claude-opus-5" (provider-prefixed)');
  assert.ok(/CHAT_MODEL_ANTHROPIC_ID\s*=\s*process\.env\.\w+\s*\?\?\s*"claude-opus-5"/.test(cfg),
    'direct id must default to the bare "claude-opus-5"');
  assert.ok(/CHAT_MODEL_OPENAI_ID\s*=\s*process\.env\.\w+\s*\?\?\s*"gpt-5\.6-sol"/.test(cfg),
    'the OpenAI id must remain defined as the assistant FALLBACK');
  // Must never be ASSIGNED as a model value (prose mentioning it is fine).
  assert.ok(!/(\?\?|:)\s*"(openai\/)?gpt-5\.6"/.test(cfg),
    'must never use a bare "gpt-5.6" as a model id — only luna/sol/terra exist, so it would 404');
});

test("the pinned assistant runs at an explicit reasoning effort", () => {
  assert.ok(/export const CHAT_EFFORT: AnthropicEffort/.test(cfg), "CHAT_EFFORT must be declared");
  assert.ok(/process\.env\.CHAT_EFFORT as AnthropicEffort\) \?\? "high"/.test(cfg),
    "the assistant must default to effort high");
});

test("assistant spend is priced from the pinned family, not the tier", () => {
  assert.ok(/opus5:\s*\{\s*inputPerM:\s*5,\s*outputPerM:\s*25\s*\}/.test(pricing),
    "claude-opus-5 pricing ($5/$25 per M, read off the live gateway listing) must be defined");
  assert.ok(/export const CHAT_PRICE_FAMILY/.test(pricing), "pricing must export CHAT_PRICE_FAMILY");
  for (const [name, src] of [["web chat", webChat], ["mobile chat", mobileChat]]) {
    assert.ok(/family:\s*CHAT_PRICE_FAMILY/.test(src),
      `${name} must meter spend with CHAT_PRICE_FAMILY (tier pricing under-counts Sol ~2x)`);
  }
});

test("chat onError serialises non-Error objects (no more '[object Object]')", () => {
  const fn = webChat.slice(webChat.indexOf("onError:"));
  assert.ok(/JSON\.stringify/.test(fn.slice(0, 700)),
    "onError must JSON.stringify non-Error values so the real cause is logged");
});
