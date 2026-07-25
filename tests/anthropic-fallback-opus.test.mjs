/**
 * tests/anthropic-fallback-opus.test.mjs
 *
 * Owner request (2026-07-22): the user-facing REASONING fallback (Ask Basil +
 * meeting prep / briefings) should fall back to Opus 4.8 at effort:high, not
 * Sonnet 5. Classification (balanced) and data-gathering (fast) fallbacks stay
 * cheap.
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

test("default + long Anthropic fallback is Opus 4.8 (direct-API hyphen form)", () => {
  const start = cfg.indexOf("export const ANTHROPIC_MODEL_IDS");
  const table = cfg.slice(start, cfg.indexOf("\n};", start));
  assert.ok(/default:\s*process\.env\.ANTHROPIC_MODEL_DEFAULT\s*\?\?\s*"claude-opus-4-8"/.test(table),
    "default tier (Ask Basil) must fall back to claude-opus-4-8");
  assert.ok(/long:\s*process\.env\.ANTHROPIC_MODEL_LONG\s*\?\?\s*"claude-opus-4-8"/.test(table),
    "long tier (meeting prep / briefings) must fall back to claude-opus-4-8");
  // Cheap tiers must NOT be promoted to Opus.
  assert.ok(/balanced:\s*process\.env\.ANTHROPIC_MODEL_BALANCED\s*\?\?\s*"claude-sonnet-5"/.test(table),
    "balanced (classification) fallback must stay Sonnet 5");
  assert.ok(/"claude-haiku-4-5-20251001"/.test(table),
    "fast (data-gathering) fallback must stay Haiku");
});

test("Opus fallback runs at effort:high, and effort is NOT applied to cheap tiers", () => {
  assert.ok(/const ANTHROPIC_EFFORT: Partial<Record<ModelKind, AnthropicEffort>> = \{/.test(cfg),
    "an ANTHROPIC_EFFORT map must exist");
  const map = cfg.slice(cfg.indexOf("const ANTHROPIC_EFFORT"), cfg.indexOf("const ANTHROPIC_EFFORT") + 300);
  assert.ok(/default:.*"high"/.test(map) && /long:.*"high"/.test(map),
    "default + long must default to effort:high");
  assert.ok(!/fast:/.test(map) && !/balanced:/.test(map),
    "fast/balanced must not set effort (Opus-4.8-era control, meaningless there)");
});

test("effort is injected via transformParams so it applies at every fallback call site", () => {
  const fn = cfg.slice(cfg.indexOf("export function getDirectAnthropicModel"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.ok(/const effort = ANTHROPIC_EFFORT\[kind\]/.test(body),
    "getDirectAnthropicModel must look up the tier's effort");
  assert.ok(/transformParams/.test(body) && /anthropic:\s*\{\s*\.\.\.\(params\.providerOptions\?\.anthropic \?\? \{\}\), effort \}/.test(body),
    "effort must be merged into providerOptions.anthropic via transformParams");
});
