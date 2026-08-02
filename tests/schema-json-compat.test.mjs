/**
 * tests/schema-json-compat.test.mjs
 *
 * Structured-output schemas must not emit JSON-Schema keywords the provider
 * rejects. This one cost real money.
 *
 * `confidenceSchema` was z.number().min(0).max(1), which serialises to
 * {"type":"number","minimum":0,"maximum":1}. The provider refuses it:
 *
 *   output_config.format.schema: For 'number' type, properties maximum,
 *   minimum are not supported
 *
 * It is embedded in 8 schemas, so EVERY structured classification failed
 * validation twice and fell back to plain generateText. The fallback worked —
 * which is exactly why nobody noticed — but each rejected attempt had already
 * sent the full ~8K-token prompt and been BILLED. And failed attempts never
 * reach commitSpend (lib/ai/generate.ts releases the reservation on error), so
 * those tokens are INVISIBLE in the spend log. Observed 2026-08-02: the owner's
 * provider bill was several times Basil's own recorded figure.
 *
 * Guarded on two axes: the source must not reintroduce the constraint, and the
 * SDK's own converter must produce a clean schema.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { zodSchema } from "@ai-sdk/provider-utils";
import { z } from "zod";

const ROOT = resolve(import.meta.dirname, "..");
const raw = readFileSync(resolve(ROOT, "lib/ai/schemas.ts"), "utf8");
// Strip comments: the docblocks explain the rejected `.min(0).max(1)` form by
// name, and matching that prose would defeat every check below.
const src = raw
  .split("\n")
  .filter((l) => {
    const t = l.trim();
    return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
  })
  .join("\n");

test("confidence is clamped by transform, not by min/max constraints", () => {
  const block = src.slice(src.indexOf("const confidenceSchema"), src.indexOf("catch(0.5)") + 12);
  // Lookbehind excludes Math.min/Math.max — the clamp itself legitimately uses
  // them; what must not appear is the ZOD constraint form.
  assert.ok(!/(?<!Math)\.min\(|(?<!Math)\.max\(/.test(block),
    "zod .min/.max on a number serialise to minimum/maximum, which the provider rejects");
  assert.ok(/\.transform\(/.test(block),
    "clamping must survive — a transform keeps the runtime guarantee without the constraint");
});

test("no number field anywhere in the AI schemas carries min/max", () => {
  // Line-scoped so a string .min(1) (legal, and used for content) doesn't trip it.
  for (const line of src.split("\n")) {
    if (!/z\.number\(\)/.test(line)) continue;
    assert.ok(!/(?<!Math)\.min\(|(?<!Math)\.max\(/.test(line),
      `z.number() with min/max will be rejected by the provider: ${line.trim()}`);
  }
});

test("the SDK converter proves the difference (this is the actual failure)", () => {
  const withConstraint = z.object({ c: z.number().min(0).max(1).catch(0.5) });
  const withTransform = z.object({
    c: z.number().transform((n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5)).catch(0.5),
  });
  const dump = (s) => JSON.stringify(zodSchema(s).jsonSchema);

  assert.match(dump(withConstraint), /"minimum"/,
    "sanity: the old form really does emit the rejected keyword");
  assert.doesNotMatch(dump(withTransform), /"minimum"|"maximum"/,
    "the transform form must serialise clean");
});

test("clamping still holds at runtime", () => {
  const s = z.number().transform((n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5)).catch(0.5);
  assert.equal(s.parse(1.7), 1, "above range clamps to 1");
  assert.equal(s.parse(-3), 0, "below range clamps to 0");
  assert.equal(s.parse(0.42), 0.42, "in-range passes through");
  assert.equal(s.parse("nonsense"), 0.5, "non-numeric falls back to 0.5");
});
