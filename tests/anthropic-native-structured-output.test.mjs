// Contact-profile drafts 500'd on 2026-10-10: "tool_choice: type "tool" and "any"
// are not supported for this model". @ai-sdk/anthropic 3.0.69 doesn't know Claude 5
// models support native structured output, so Output.object fell back to a FORCED
// json tool — which Opus 5.5 rejects. This drives the real SDK through the real
// model factory and inspects the request it would send to Anthropic.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { loadTs } from "./_helpers/load-ts.mjs";

const require = createRequire(import.meta.url);
const ai = require("ai");
const { createAnthropic } = require("@ai-sdk/anthropic");
const { z } = require("zod");

function harness(env) {
  const sent = [];
  const fakeFetch = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({
      id: "msg_test", type: "message", role: "assistant", model: "m",
      content: [{ type: "text", text: JSON.stringify({ personality: "steady" }) }],
      stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const cfg = loadTs("lib/ai/model-config.ts", {
    ai,
    "@ai-sdk/anthropic": { createAnthropic: (o) => createAnthropic({ ...o, fetch: fakeFetch }) },
    "@ai-sdk/openai": { createOpenAI: () => () => null },
  }, { ANTHROPIC_API_KEY: "test-key", AI_GATEWAY_DISABLED: "1", ...env });
  return { cfg, sent };
}

const draft = (model) => ai.generateText({
  model, prompt: "profile",
  output: ai.Output.object({ schema: z.object({ personality: z.string() }), name: "ContactProfile" }),
});

test("Opus 5.5 structured output uses native output_config.format, never a forced tool", async () => {
  const { cfg, sent } = harness({ ANTHROPIC_MODEL_DEFAULT: "claude-opus-5-5" });
  const r = await draft(cfg.getDirectAnthropicModel("default"));
  assert.equal(r.output.personality, "steady");
  const body = sent[0];
  assert.equal(body.output_config?.format?.type, "json_schema");
  assert.equal(body.output_config?.effort, "medium", "effort must still ride along");
  assert.equal(body.tool_choice, undefined, `no forced tool_choice; got ${JSON.stringify(body.tool_choice)}`);
});

test("models the SDK already knows keep its own choice (Haiku 4.5 tier untouched)", async () => {
  const { cfg, sent } = harness({ ANTHROPIC_MODEL_BALANCED: "claude-haiku-4-5-20251001" });
  await draft(cfg.getDirectAnthropicModel("balanced"));
  assert.equal(sent[0].output_config?.format?.type, "json_schema");
  assert.equal(sent[0].output_config?.effort, undefined, "Haiku rejects effort — must not gain it");
});

test("needsNativeStructuredOutput matches Claude 5+ ids only", () => {
  const { cfg } = harness({});
  for (const id of ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-5-5", "claude-opus-10-1"])
    assert.equal(cfg.needsNativeStructuredOutput(id), true, id);
  for (const id of ["claude-haiku-4-5-20251001", "claude-opus-4-8", "claude-sonnet-4-6", "claude-3-haiku-20240307"])
    assert.equal(cfg.needsNativeStructuredOutput(id), false, id);
});
