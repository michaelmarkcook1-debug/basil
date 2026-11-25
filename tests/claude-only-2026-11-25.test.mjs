// Owner, 2026-11-25: "Revert to Claude models, there is a significant drop in
// quality and reasoning." From 23 to 24 Nov the Anthropic credit ran out and
// every call quietly fell back to OpenAI for a day and a half; the spend log,
// which records the model asked for, hid it. Basil now answers with Claude
// only, and says so on Today when Claude refuses for billing.
import test from "node:test";
import assert from "node:assert/strict";
import { loadTs, nextServer } from "./_helpers/load-ts.mjs";

const fakeProvider = (name) => () => (id) => ({ provider: name, modelId: id });
// The loader gives each module its own environment (third argument).
const loadConfig = (env) => loadTs("lib/ai/model-config.ts", {
  ai: { gateway: (id) => ({ provider: "gateway", modelId: id }), wrapLanguageModel: ({ model }) => model },
  "@ai-sdk/anthropic": { createAnthropic: fakeProvider("anthropic") },
  "@ai-sdk/openai": { createOpenAI: fakeProvider("openai") },
}, env);

test("OpenAI never answers unless it is switched back on", () => {
  // Production on 2026-11-25: an OpenAI key is set, AI_PREFER_OPENAI is "0".
  const prod = loadConfig({ OPENAI_API_KEY: "sk-test", ANTHROPIC_API_KEY: "test", AI_PREFER_OPENAI: "0", AI_GATEWAY_DISABLED: "1" });
  assert.equal(prod.openAIAllowed(), false);
  assert.equal(prod.getDirectOpenAIModel("default"), null, "no OpenAI fallback for any tier");
  assert.equal(prod.getDirectOpenAIModel("balanced"), null);
  assert.equal(prod.PROVIDER_MODE, "anthropic_direct");

  const back = loadConfig({ OPENAI_API_KEY: "sk-test", AI_OPENAI_FALLBACK: "1" });
  assert.equal(back.openAIAllowed(), true);
  assert.equal(back.getDirectOpenAIModel("default")?.provider, "openai", "the fallback comes back when asked for");

  assert.equal(loadConfig({ OPENAI_API_KEY: "sk-test", AI_PREFER_OPENAI: "1" }).openAIAllowed(), true, "OpenAI as primary still works when chosen");
  assert.equal(loadConfig({ AI_OPENAI_FALLBACK: "1" }).getDirectOpenAIModel("default"), null, "no key, no model");
});

const H = () => {
  const counters = new Map();
  return {
    counters,
    mod: loadTs("lib/ai/provider-health.ts", {
      "@/lib/storage/counter": {
        incrCounter: async (k, n) => { counters.set(k, (counters.get(k) ?? 0) + n); return { value: counters.get(k), durable: true }; },
        getCounter: async (k) => counters.get(k) ?? 0,
      },
    }),
  };
};

test("a billing refusal from Anthropic is recorded; other failures are not", async () => {
  const { mod, counters } = H();
  assert.equal(mod.isBillingError(new Error("Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.")), true);
  assert.equal(mod.isBillingError(new Error("429 rate limit")), false);
  assert.equal(mod.isBillingError(new Error("timed out")), false);
  await mod.noteAiFailure(new Error("overloaded"), 1_000_000);
  assert.equal(await mod.claudeCreditOut(), false);
  await mod.noteAiFailure(new Error("Your credit balance is too low to access the Anthropic API."), 2_000_000);
  assert.equal(await mod.claudeCreditOut(), true);
  // At most once a minute per instance: a burst of failing calls is one write.
  await mod.noteAiFailure(new Error("Your credit balance is too low"), 2_030_000);
  assert.equal(counters.get("ai:claude-credit-out"), 1);
});

test("/api/ai/status tells Today when Claude is out of credit", async () => {
  const route = loadTs("app/api/ai/status/route.ts", {
    "next/server": nextServer,
    "@/lib/auth": { getSessionUser: async () => "fixture" },
    "@/lib/ai/provider-health": { claudeCreditOut: async () => true },
    "@/lib/ai/model-config": { PROVIDER_MODE: "anthropic_direct", getChatModel: () => ({ modelId: "claude-opus-5-5" }) },
  });
  const res = await route.GET();
  assert.equal(res.body.claudeCreditOut, true);
  assert.equal(res.body.model, "claude-opus-5-5");
});
