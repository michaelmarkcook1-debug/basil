// Model bench (2026-11-10): Basil ran Haiku 4.5 and Opus 5.5 while Haiku 5.5 and
// Sonnet 5.5 were a tenth and a half of the price. The owner's rule is to test a
// new model on Basil's own prompts through the production path before switching,
// and the production key cannot be read back — so the test has to run in
// production, on real work, without touching what the live app does.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { loadTs } from "./_helpers/load-ts.mjs";

const require = createRequire(import.meta.url);
const ai = require("ai");
const { createAnthropic } = require("@ai-sdk/anthropic");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

/** The real model factory over the real SDK, with Anthropic's HTTP answered locally. */
function harness(env = {}) {
  const sent = [];
  const fakeFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    return new Response(JSON.stringify({
      id: "msg_test", type: "message", role: "assistant", model: body.model,
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens_details: { thinking_tokens: 90 } },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const cfg = loadTs("lib/ai/model-config.ts", {
    ai,
    "@ai-sdk/anthropic": { createAnthropic: (o) => createAnthropic({ ...o, fetch: fakeFetch }) },
    "@ai-sdk/openai": { createOpenAI: () => () => null },
  }, { ANTHROPIC_API_KEY: "test-key", AI_GATEWAY_DISABLED: "1", ...env });
  return { cfg, sent };
}
const ask = (model) => ai.generateText({ model, prompt: "hello" });

test("outside a bench every tier resolves to its production model and effort", async () => {
  const { cfg, sent } = harness();
  await ask(cfg.getDirectAnthropicModel("balanced"));
  await ask(cfg.getDirectAnthropicModel("long"));
  await ask(cfg.getChatModel("long"));
  assert.equal(sent[0].model, cfg.ANTHROPIC_MODEL_IDS.balanced);
  assert.equal(sent[0].output_config?.effort, undefined);
  assert.equal(sent[1].model, cfg.ANTHROPIC_MODEL_IDS.long);
  assert.equal(sent[1].output_config?.effort, "high");
  assert.equal(sent[2].model, cfg.CHAT_MODEL_ANTHROPIC_ID);
  assert.equal(sent[2].output_config?.effort, cfg.CHAT_EFFORT);
});

test("a variant swaps the model for its tier, in that call chain only, and records what it used", async () => {
  const { cfg, sent } = harness();
  const variant = { label: "candidate", model: "claude-haiku-5-5" };
  const [bench] = await Promise.all([
    cfg.runModelBench("balanced", variant, async () => {
      await new Promise((r) => setTimeout(r, 5));
      await ask(cfg.getDirectAnthropicModel("balanced"));
      return "done";
    }),
    // Live traffic running at the same moment must not see the swap.
    ask(cfg.getDirectAnthropicModel("balanced")),
  ]);
  const models = sent.map((b) => b.model).sort();
  assert.deepEqual(models, [cfg.ANTHROPIC_MODEL_IDS.balanced, "claude-haiku-5-5"].sort());
  assert.equal(bench.result, "done");
  assert.equal(bench.calls.length, 1, "only the bench's own call is recorded");
  assert.equal(bench.calls[0].modelId, "claude-haiku-5-5");
  assert.equal(bench.calls[0].inputTokens, 1200);
  assert.equal(bench.calls[0].outputTokens, 340);
  assert.ok(bench.calls[0].ms >= 0);
});

test("effort: the variant's own, else the candidate's default, else production's", async () => {
  const { cfg, sent } = harness();
  const run = (kind, variant, model) => cfg.runModelBench(kind, variant, () => ask(model()));
  await run("long", { label: "a", model: "claude-opus-5-5", effort: "medium" }, () => cfg.getDirectAnthropicModel("long"));
  await run("long", { label: "b", model: "claude-opus-5-5" }, () => cfg.getDirectAnthropicModel("long"));
  await run("long", { label: "c", effort: "low" }, () => cfg.getDirectAnthropicModel("long"));
  const base = await run("long", { label: "production" }, () => cfg.getDirectAnthropicModel("long"));
  assert.deepEqual(sent.map((b) => [b.model, b.output_config?.effort]), [
    ["claude-opus-5-5", "medium"],
    ["claude-opus-5-5", undefined],
    [cfg.ANTHROPIC_MODEL_IDS.long, "low"],
    [cfg.ANTHROPIC_MODEL_IDS.long, "high"],
  ]);
  assert.equal(base.calls.length, 1, "the production arm is measured too");
  // A variant for one tier leaves the other tiers alone.
  await run("long", { label: "d", model: "claude-opus-5-5" }, () => cfg.getDirectAnthropicModel("balanced"));
  assert.equal(sent.at(-1).model, cfg.ANTHROPIC_MODEL_IDS.balanced);
});

test("the operational read's pinned model follows a variant too", async () => {
  const { cfg, sent } = harness();
  const r = await cfg.runModelBench("long", { label: "s", model: "claude-sonnet-5-5", effort: "low" }, () => ask(cfg.getChatModel("long")));
  assert.equal(sent[0].model, "claude-sonnet-5-5");
  assert.equal(sent[0].output_config?.effort, "low");
  assert.equal(r.calls[0].modelId, "claude-sonnet-5-5");
});

test("variants are validated: 1–5, a label, a claude model id, a known effort", () => {
  const { cfg } = harness();
  const ok = cfg.parseBenchVariants('[{"label":"production"},{"label":"haiku 5.5","model":"claude-haiku-5-5","effort":"low"}]');
  assert.equal(JSON.stringify(ok), JSON.stringify([{ label: "production" }, { label: "haiku 5.5", model: "claude-haiku-5-5", effort: "low" }]));
  for (const bad of [null, "", "not json", "[]", '[{"model":"claude-haiku-5-5"}]', '[{"label":"x","model":"gpt-5"}]', '[{"label":"x","effort":"turbo"}]', JSON.stringify(Array(6).fill({ label: "x" }))]) {
    assert.equal(cfg.parseBenchVariants(bad), null, String(bad));
  }
});

test("the bench is an admin's own session only, and the briefing bench returns before anything is stored", () => {
  const route = src("app/api/admin/model-bench/route.ts");
  assert.match(route, /if \(!username \|\| !isAdminUser\(username\)\) return NextResponse\.json\(\{ error: "Forbidden" \}, \{ status: 403 \}\);/);
  assert.doesNotMatch(route, /materializeSlackIntelligence|recordIngest|writeGenerateCache|x-basil-username/, "classifies only: files nothing, marks nothing seen, acts for no one else");

  const briefing = src("app/api/generate/briefing/route.ts");
  assert.match(briefing, /const benchVariants = !isCronCall && isAdminUser\(username\)/);
  const benchReturn = briefing.indexOf("return Response.json({ bench });");
  assert.ok(benchReturn > 0);
  assert.ok(benchReturn < briefing.indexOf("await writeGenerateCache(username, `briefing-${briefingType}`"), "returns before the live briefing is overwritten");

  const engine = src("lib/stig/engine.ts");
  const bench = engine.slice(engine.indexOf("export async function benchStigBriefing"), engine.indexOf("export async function runStigBriefing"));
  assert.doesNotMatch(bench, /writeGenerateCache|readGenerateCache/, "the bench read is never stored or reused");
});
