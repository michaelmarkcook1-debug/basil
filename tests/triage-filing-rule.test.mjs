// The FYI filing bar (2026-11-10). It was 0.8, tuned to Haiku 4.5, which says
// 0.9 for almost anything. Benched on 20 real Slack threads and 20 real emails,
// Haiku 5.5 said about 0.7 for the same FYIs: the old bar filed 17 threads from
// one model and 5 from the other, and dropped a follow-up the newer model had
// spotted ("the HTML version is to follow") because it sat in an FYI thread.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadTs } from "./_helpers/load-ts.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

const mocks = {
  "@/lib/security/sensitive": { redactSensitive: (s) => s, redactDeep: (v) => ({ value: v }) },
  "@/lib/ai/generate": {},
  "@/lib/ai/model-config": { MAX_TOKENS: {} },
  "@/lib/ai/system-prompt": {},
  "@/lib/ai/parse-json": {},
  "@/lib/ai/schemas": {},
  "@/core/feature-flags": {},
  "@/lib/settings/store": {},
};
const slack = loadTs("lib/slack/classify-slack.ts", mocks);
const email = loadTs("lib/email/classify-email.ts", mocks);

const fyi = (over = {}) => ({
  category: "informational", confidence: 0.7, actions: [], decisions: [],
  people: [{ name: "Mike Trujillo" }], companies: [], keyContext: "Mike shared the webpage entries.", ...over,
});
const cases = [
  ["slack", slack.shouldMaterializeSlack, (o) => fyi(o), "noise"],
  ["email", email.shouldMaterialize, (o) => fyi({ category: "informational_only", ...o }), "low_value_noise"],
];

for (const [name, files, make, noise] of cases) {
  test(`${name}: a clear FYI that names someone is filed at 0.7, the confidence Haiku 5.5 reports`, () => {
    assert.equal(files(make()), true);
    assert.equal(files(make({ confidence: 0.9 })), true, "Haiku 4.5's usual 0.9 still files");
  });

  test(`${name}: an FYI the model is unsure of, or that names no one, is still left out`, () => {
    assert.equal(files(make({ confidence: 0.5 })), false, "a one-liner it cannot place");
    assert.equal(files(make({ confidence: 0.69 })), false);
    assert.equal(files(make({ people: [], companies: [] })), false, "nobody to remember it against");
    assert.equal(files(make({ keyContext: "" })), false);
  });

  test(`${name}: an FYI that carries an action or a decision is filed whatever its confidence above the floor`, () => {
    assert.equal(files(make({ confidence: 0.5, people: [], actions: [{ text: "Deliver the HTML version" }] })), true);
    assert.equal(files(make({ confidence: 0.5, decisions: [{ text: "Keep the current examples" }] })), true);
    assert.equal(files(make({ confidence: 0.3, actions: [{ text: "x" }] })), false, "below the 0.35 floor nothing is filed");
  });

  test(`${name}: noise is never filed, even with an action attached`, () => {
    assert.equal(files(make({ category: noise, confidence: 0.9, actions: [{ text: "x" }] })), false);
  });
}

test("both sources share one bar, and it is the 0.7 the bench supports", () => {
  assert.equal(slack.INFORMATIONAL_MIN_CONFIDENCE, 0.7);
  assert.equal(email.INFORMATIONAL_MIN_CONFIDENCE, 0.7);
  for (const f of ["lib/slack/classify-slack.ts", "lib/email/classify-email.ts"]) {
    assert.doesNotMatch(src(f).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n"), /confidence >= 0\.8/, `${f} has no leftover 0.8 bar`);
  }
});

test("the long tier is priced as the model it runs", () => {
  const pricing = loadTs("lib/ai/pricing.ts", { "./model-config": { RESERVE_OUTPUT_TOKENS: { fast: 2_000, balanced: 3_000, default: 6_000, long: 8_000 } } });
  assert.equal(pricing.familyForTier("long"), "sonnet55");
  assert.equal(pricing.familyForTier("default"), "opus55", "Ask Basil's tier is unchanged");
  assert.equal(JSON.stringify(pricing.FAMILY_PRICING.sonnet55), JSON.stringify({ inputPerM: 2, outputPerM: 10 }));
  assert.equal(JSON.stringify(pricing.FAMILY_PRICING.haiku55), JSON.stringify({ inputPerM: 0.1, outputPerM: 0.5 }));
  // The benched briefing: 19,065 in, 5,590 out on Sonnet 5.5.
  assert.equal(pricing.costUsd("sonnet55", { inputTokens: 19_065, outputTokens: 5_590 }).toFixed(3), "0.094");
  assert.match(src("lib/ai/model-config.ts"), /long:\s*process\.env\.ANTHROPIC_MODEL_LONG\s*\?\?\s*"claude-sonnet-5-5"/);
});
