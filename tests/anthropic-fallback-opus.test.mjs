/**
 * tests/anthropic-fallback-opus.test.mjs
 *
 * OWNER POLICY 2026-07-23: Anthropic is the PRIMARY provider and Claude Opus 5
 * serves both user-facing tiers —
 *   mid tier (balanced — email/Slack categorisation) → Opus 5 @ effort LOW
 *   top tier (default/long — Ask Basil, meeting prep, briefings) → Opus 5 @ HIGH
 * Data-gathering (fast) stays on Haiku; GPT-5.6 becomes the resilience fallback.
 *
 * (Supersedes the 2026-07-22 arrangement, where GPT-5.6 was primary and Opus 4.8
 * was the fallback.)
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

test("mid + top tiers run Opus 5; data-gathering stays cheap", () => {
  const start = cfg.indexOf("export const ANTHROPIC_MODEL_IDS");
  const table = cfg.slice(start, cfg.indexOf("\n};", start));
  for (const tier of ["balanced", "default", "long"]) {
    assert.ok(
      new RegExp(`${tier}:\\s*process\\.env\\.ANTHROPIC_MODEL_${tier.toUpperCase()}\\s*\\?\\?\\s*"claude-opus-5"`).test(table),
      `${tier} tier must resolve to claude-opus-5 (direct-API form of anthropic/claude-opus-5)`
    );
  }
  assert.ok(/"claude-haiku-4-5-20251001"/.test(table),
    "fast (data-gathering) must stay on Haiku — Opus there is pure waste");
});

test("effort is high for the top tier and low for the high-volume mid tier", () => {
  const start = cfg.indexOf("const ANTHROPIC_EFFORT");
  const map = cfg.slice(start, cfg.indexOf("\n};", start));
  assert.ok(/balanced:.*"low"/.test(map),
    "mid tier is every email + Slack message — it must run at effort low");
  assert.ok(/default:.*"high"/.test(map) && /long:.*"high"/.test(map),
    "top tier is what a human reads — effort high");
  assert.ok(!/\bfast:/.test(map),
    "fast must not set effort (it runs Haiku, where the control is meaningless)");
});

test("effort is injected via shared middleware, applying at every call site", () => {
  assert.ok(/function anthropicEffortMiddleware\(effort: AnthropicEffort\)/.test(cfg),
    "a single shared middleware must own effort injection");
  assert.ok(/anthropic:\s*\{\s*\.\.\.\(params\.providerOptions\?\.anthropic \?\? \{\}\), effort \}/.test(cfg),
    "effort must be merged into providerOptions.anthropic via transformParams");
  // Both the tier-resolved models and the pinned assistant must use it.
  const uses = [...cfg.matchAll(/anthropicEffortMiddleware\(/g)];
  assert.ok(uses.length >= 3,
    "the middleware must be applied by getDirectAnthropicModel AND the pinned chat model");
});
