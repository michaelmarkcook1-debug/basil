/**
 * tests/ai-tiering-policy.test.mjs
 *
 * Locks the owner's AI tiering policy:
 *
 *   basic DATA GATHERING   → lowest tier  (fast)     → gpt-5.6-luna  ($1/$6)
 *   CATEGORIZATION         → mid tier     (balanced) → gpt-5.6-terra ($2.50/$15)
 *   CONTEXTUAL + REASONING → flagship     (default/long) → gpt-5.6-sol ($5/$30)
 *
 * Two things drift silently and are guarded here:
 *   1. The tier→model mapping (a wrong/phantom id 404s every call — that has
 *      already caused one full AI outage via "gpt-5.5" / "gpt-5.4-mini").
 *   2. The workload→tier assignment. Classification originally ran on "fast",
 *      which put categorization on the LOWEST tier — the opposite of policy.
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

test("tier → GPT-5.6 model mapping matches the policy", () => {
  const block = cfg.slice(cfg.indexOf("export const OPENAI_MODEL_IDS"), cfg.indexOf("// ── Token defaults"));
  const expected = {
    fast: "gpt-5.6-luna",      // data gathering
    balanced: "gpt-5.6-terra", // categorization
    default: "gpt-5.6-sol",    // contextual + reasoning
    long: "gpt-5.6-sol",
  };
  for (const [tier, model] of Object.entries(expected)) {
    assert.ok(new RegExp(`${tier}:[^\\n]*\\?\\?\\s*"${model.replace(/\./g, "\\.")}"`).test(block),
      `OPENAI_MODEL_IDS.${tier} must default to "${model}"`);
  }
});

test("every tier stays independently env-overridable (retune cost without a deploy)", () => {
  const block = cfg.slice(cfg.indexOf("export const OPENAI_MODEL_IDS"), cfg.indexOf("// ── Token defaults"));
  for (const v of ["OPENAI_MODEL_FAST", "OPENAI_MODEL_BALANCED", "OPENAI_MODEL_DEFAULT", "OPENAI_MODEL_LONG"]) {
    assert.ok(block.includes(v), `${v} override must remain wired`);
  }
});

test("price families match the real per-tier model rates", () => {
  assert.ok(/gpt56luna:\s*\{\s*inputPerM:\s*1,\s*outputPerM:\s*6\s*\}/.test(pricing), "luna = $1/$6");
  assert.ok(/gpt56terra:\s*\{\s*inputPerM:\s*2\.5,\s*outputPerM:\s*15\s*\}/.test(pricing), "terra = $2.50/$15");
  assert.ok(/gpt56sol:\s*\{\s*inputPerM:\s*5,\s*outputPerM:\s*30\s*\}/.test(pricing), "sol = $5/$30");
  const fn = pricing.slice(pricing.indexOf("export function familyForTier"));
  const body = fn.slice(0, fn.indexOf("\n}") + 2);
  assert.ok(/case "fast": return "gpt56luna"/.test(body), "fast prices as luna");
  assert.ok(/case "balanced": return "gpt56terra"/.test(body), "balanced prices as terra");
  assert.ok(/return "gpt56sol"/.test(body), "default/long price as sol");
});

test("CATEGORIZATION workloads run on the mid tier, never the lowest", () => {
  const categorizers = [
    ["lib/email/classify-email.ts", "classify:email"],
    ["lib/slack/classify-slack.ts", "classify:slack"],
    ["app/api/actions/classify/route.ts", "classify:actions"],
    ["lib/zoom/process-meeting.ts", "zoom:process"],
  ];
  for (const [path, feature] of categorizers) {
    const src = read(path);
    assert.ok(new RegExp(`\\}, *"balanced", *\\{[^}]*feature: *"${feature}"`).test(src),
      `${feature} must meter at the "balanced" (categorization) tier`);
    assert.ok(!/model: getTextModel\("fast"\)/.test(src),
      `${feature} must not resolve the lowest-tier model — categorization is mid tier`);
  }
});

test("the dispatch PRIMARY path is tiered too, not just the fallback", () => {
  // classify-* have TWO ai paths: dispatch() (primary, via modelKind) and a
  // generateTextSafe fallback (via getTextModel). Re-tiering only the fallback
  // left every real classification on the lowest tier — and, because the trace
  // labels from GATEWAY_MODEL_IDS[modelKind], reporting itself as Haiku.
  for (const path of ["lib/email/classify-email.ts", "lib/slack/classify-slack.ts"]) {
    const src = read(path);
    assert.ok(!/modelKind: *"fast"/.test(src),
      `${path}: dispatch() must not classify on the lowest tier`);
    assert.ok(/modelKind: *"balanced"/.test(src),
      `${path}: dispatch() must classify on the mid tier`);
  }
});

test("dispatch traces record the model that ACTUALLY ran, not the gateway slug", () => {
  const src = read("core/dispatch/dispatcher.ts");
  assert.ok(!/const resolvedModelId = GATEWAY_MODEL_IDS\[modelKind\];/.test(src),
    "resolvedModelId must not be hardcoded to the gateway id — that mislabels every trace when the gateway is off");
  assert.ok(/typeof model === "string" \? model : \(model\.modelId/.test(src),
    "resolvedModelId must derive from the resolved model instance");
});

test("REASONING workloads run on the flagship tier", () => {
  const reasoners = [
    ["lib/events/drafter.ts", "draft", "default"],
    ["app/api/generate/email/route.ts", "email-compose", "default"],
    ["app/api/generate/digest/route.ts", "digest", "long"],
    ["app/api/generate/briefing/route.ts", "briefing", "long"],
    ["app/api/generate/meeting-prep/route.ts", "meeting-prep", "long"],
  ];
  for (const [path, feature, tier] of reasoners) {
    const src = read(path);
    assert.ok(new RegExp(`\\}, *"${tier}", *\\{[^}]*feature: *"${feature}"`).test(src),
      `${feature} must meter at the flagship "${tier}" tier`);
  }
});

test("DATA-GATHERING extraction uses the lowest-tier MODEL but keeps its long budget", () => {
  const src = read("lib/zoom/extract-meeting.ts");
  assert.ok(/model: getTextModel\("fast"\)/.test(src),
    "zoom extraction is data gathering — it must use the lowest-tier model");
  // kind stays "long": it drives the 8192 output reservation + the generous
  // attempt timeout. A "fast" kind would abort a full transcript extract.
  assert.ok(/"long",\s*\n\s*\/\/[\s\S]{0,200}?family: familyForTier\("fast"\)/.test(src),
    "it must keep the long budget/timeout while pricing at the lowest tier");
});
