/**
 * tests/stig-token-optional.test.mjs
 *
 * Guards the STIG_API_TOKEN UI / health clarity fix.
 *
 * STIG_API_TOKEN is optional — it only enables Siri Shortcuts and external
 * API callers. It must NEVER appear to users as a blocker for in-browser
 * Chat or Briefing functionality.
 *
 * Regression: The health panel previously showed "Stig API token — STIG_API_TOKEN
 * is not set" as an Info check, which users misread as "the Stig brain is offline."
 * The fix: rename the label to "Siri / External API token (optional)" and always
 * set ok: true so the check is cosmetic only.
 *
 * Runs via: npm test  (node --test)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}

// ── Health route ──────────────────────────────────────────────────────────────

test("health route includes STIG_API_TOKEN as an ENV_CHECKS key", () => {
  const src = read("app/api/health/route.ts");

  // STIG_API_TOKEN must be present as a key in ENV_CHECKS so its presence is
  // reported in the health panel. The label in lib/readiness.ts clarifies it
  // is optional (Siri / External API token) so it never shows as a blocker.
  const envChecksBlock = src.match(/const ENV_CHECKS\s*=\s*\{([\s\S]*?)\}\s*as const/)?.[1] ?? "";
  // Strip single-line comments before checking for the key pattern
  const strippedBlock = envChecksBlock.replace(/\/\/[^\n]*/g, "");
  assert.ok(
    strippedBlock.includes("STIG_API_TOKEN"),
    "STIG_API_TOKEN must be a key in ENV_CHECKS — its presence should be reported in the health panel"
  );
});

test("health route does not include STIG_API_USERNAME as an ENV_CHECKS key", () => {
  const src = read("app/api/health/route.ts");
  const envChecksBlock = src.match(/const ENV_CHECKS\s*=\s*\{([\s\S]*?)\}\s*as const/)?.[1] ?? "";
  const strippedBlock = envChecksBlock.replace(/\/\/[^\n]*/g, "");
  assert.ok(
    !strippedBlock.includes("STIG_API_USERNAME"),
    "STIG_API_USERNAME must NOT be a key in ENV_CHECKS — it is optional"
  );
});

// ── Readiness utility ─────────────────────────────────────────────────────────

test("readiness check for STIG token is always ok:true", () => {
  const src = read("lib/readiness.ts");

  // Find the stig_token check block — it must set ok: true regardless of token presence
  // (we use a simple approach: assert ok: true appears near the stig_token id)
  const stigBlock = src.split("id: \"stig_token\"")[1]?.split("id:")[0] ?? "";
  assert.ok(
    stigBlock.includes("ok: true"),
    'readiness stig_token check must have ok: true — the token is optional, never a blocker'
  );
});

test("readiness check label for STIG token is NOT 'Stig API token'", () => {
  const src = read("lib/readiness.ts");
  // Old misleading label must be gone
  assert.ok(
    !src.includes('"Stig API token"'),
    'The label "Stig API token" is misleading — it must be renamed to something ' +
    'that clarifies it\'s only needed for Siri/external callers'
  );
});

test("readiness check label for STIG token mentions optional/external/Siri", () => {
  const src = read("lib/readiness.ts");
  const stigBlock = src.split("id: \"stig_token\"")[1]?.split("// ")[0] ?? "";
  const hasOptionalLanguage =
    stigBlock.includes("optional") ||
    stigBlock.includes("Siri") ||
    stigBlock.includes("external") ||
    stigBlock.includes("External");
  assert.ok(
    hasOptionalLanguage,
    'STIG token label must include "optional", "Siri", or "external" to ' +
    'prevent users from thinking the Stig brain is offline'
  );
});

test("readiness check severity for STIG token is info", () => {
  const src = read("lib/readiness.ts");
  // Find the stig_token checks.push block and extract everything up to the next
  // checks.push or end of the array. We strip line comments before scanning.
  const afterId = src.split('id: "stig_token"')[1] ?? "";
  // Take everything up to the next `checks.push` call
  const stigBlock = afterId.split("checks.push")[0] ?? afterId;
  // Strip single-line comments so inline `// ...` don't hide the values
  const cleaned = stigBlock.replace(/\/\/[^\n]*/g, "");
  assert.ok(
    cleaned.includes('"info"'),
    'STIG token check severity must be "info" — never "warning" or "blocker"'
  );
});

// ── Stig engine ───────────────────────────────────────────────────────────────

test("Stig engine does not require STIG_API_TOKEN to function", () => {
  const src = read("lib/stig/engine.ts");
  // The engine must not gate on STIG_API_TOKEN — that token is only for external callers
  // It may reference it in comments, but must not block on it
  const gatesOnToken =
    src.includes("if (!process.env.STIG_API_TOKEN)") ||
    src.includes("!process.env.STIG_API_TOKEN &&") ||
    src.includes("process.env.STIG_API_TOKEN === undefined");
  assert.ok(
    !gatesOnToken,
    "Stig engine must not gate on STIG_API_TOKEN — token is only for external/Siri callers"
  );
});
