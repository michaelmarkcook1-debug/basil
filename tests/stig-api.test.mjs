/**
 * tests/stig-api.test.mjs
 *
 * Regression guard for the embedded Stig API namespace.
 * The Stig must live inside Basil, not as a separate localhost/FastAPI process.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function exists(rel) {
  return existsSync(join(ROOT, rel));
}

function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}

test("embedded Stig API routes exist", () => {
  for (const route of [
    "app/api/stig/status/route.ts",
    "app/api/stig/ask/route.ts",
    "app/api/stig/siri/route.ts",
    "app/api/stig/briefing/route.ts",
  ]) {
    assert.ok(exists(route), `${route} is missing`);
  }
});

test("Stig API routes use Basil auth/token resolver", () => {
  for (const route of [
    "app/api/stig/status/route.ts",
    "app/api/stig/ask/route.ts",
    "app/api/stig/siri/route.ts",
    "app/api/stig/briefing/route.ts",
  ]) {
    const src = read(route);
    assert.ok(src.includes("getStigRequestUser"), `${route} must call getStigRequestUser`);
    assert.ok(src.includes("Unauthorised"), `${route} must reject unauthorised calls`);
  }
});

test("Stig API uses internal Basil context and not a localhost proxy", () => {
  const engine = read("lib/stig/engine.ts");
  const context = read("lib/stig/context.ts");
  assert.ok(engine.includes("buildAssistantTools"), "Stig engine must use Basil assistant tools");
  assert.ok(context.includes("buildProjectTruth"), "Stig context must include Project Truth Layer");
  assert.ok(context.includes("buildSlackCommandCentre"), "Stig context must include Slack Command Centre");
  assert.ok(!engine.includes("localhost:8000"), "Stig must not depend on old localhost FastAPI");
});
