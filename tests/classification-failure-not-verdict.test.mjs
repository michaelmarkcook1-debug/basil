/**
 * tests/classification-failure-not-verdict.test.mjs
 *
 * An AI outage must not permanently mark real mail as junk.
 *
 * The failure placeholder returned by classifyEmail/classifySlack is
 * category:"low_value_noise" / confidence 0 — INDISTINGUISHABLE from a genuine
 * "this is noise" verdict. Callers then recorded its content hash, so
 * isHashUnchanged skipped the item on every later run. Net effect: anything
 * arriving while the provider was down was written off as junk and never
 * reconsidered, even after the provider recovered.
 *
 * Observed live 2026-08-02: the Anthropic key returned 401 (invalid) and the
 * OpenAI fallback had no credits, so every email in that window logged
 * "→ low_value_noise (confidence=0)" and had its hash recorded.
 *
 * The fix is a explicit `classificationFailed` flag that callers must honour
 * BEFORE recording an ingest hash.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

const email = read("lib/email/classify-email.ts");
const slack = read("lib/slack/classify-slack.ts");
const process_ = read("lib/email/process-gmail-message.ts");
const poll = read("app/api/events/poll-ingest/route.ts");
const reprocess = read("app/api/events/reprocess/route.ts");

test("both classifiers flag a failed call instead of returning a bare verdict", () => {
  for (const [name, src] of [["email", email], ["slack", slack]]) {
    assert.ok(/classificationFailed\?: boolean/.test(src),
      `${name}: the intelligence type must carry an explicit failure flag`);
    // The catch path must set it — not just declare the field.
    const catchIdx = src.lastIndexOf("classification failed:");
    assert.ok(catchIdx > -1, `${name}: catch path must exist`);
    const after = src.slice(catchIdx, catchIdx + 400);
    assert.ok(/classificationFailed: true/.test(after),
      `${name}: the catch path must MARK the placeholder, or callers cannot tell`);
  }
});

test("no caller records an ingest hash for a failed classification", () => {
  const sites = [
    ["process-gmail-message", process_],
    ["poll-ingest", poll],
    ["reprocess", reprocess],
  ];
  for (const [name, src] of sites) {
    assert.ok(/intel\.classificationFailed/.test(src),
      `${name}: must check the failure flag before treating the result as a verdict`);
    // The guard has to come BEFORE the shouldMaterialize branch that records.
    const guard = src.indexOf("intel.classificationFailed");
    const materialize = src.search(/if \(!shouldMaterialize/);
    assert.ok(guard > -1 && materialize > -1 && guard < materialize,
      `${name}: the failure guard must run BEFORE the record-and-skip branch`);
  }
});

test("a failed classification is logged, not swallowed", () => {
  for (const [name, src] of [["process-gmail-message", process_], ["poll-ingest", poll], ["reprocess", reprocess]]) {
    const at = src.indexOf("intel.classificationFailed");
    const block = src.slice(at, at + 400);
    assert.ok(/console\.warn/.test(block),
      `${name}: an outage that silently drops work is exactly what caused this`);
  }
});

test("a genuine low-value verdict IS still recorded (no regression)", () => {
  // The point is to distinguish failure from verdict — not to stop recording
  // real verdicts, which would re-classify the same junk mail forever.
  assert.ok(/if \(!shouldMaterialize\(intel\)\) \{[\s\S]{0,200}recordIngest/.test(process_),
    "a real low-value result must still record its hash");
});
