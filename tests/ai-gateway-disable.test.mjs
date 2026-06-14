/**
 * tests/ai-gateway-disable.test.mjs
 *
 * Regression guard for the brain outage fix: AI_GATEWAY_DISABLED must actually
 * bypass the Vercel AI Gateway in EVERY provider-selection path. The outage was
 * caused by getTextModel checking the raw gateway token directly and ignoring
 * the disable flag, so it kept routing every call (including chat's streamText)
 * to a credit-less gateway.
 *
 * Static source analysis — no TypeScript compilation required.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const src = readFileSync(resolve(ROOT, "lib/ai/model-config.ts"), "utf8");

test("isGatewayEnabled() exists and honours AI_GATEWAY_DISABLED", () => {
  assert.ok(/export function isGatewayEnabled\s*\(/.test(src),
    "model-config must export isGatewayEnabled()");
  assert.ok(/AI_GATEWAY_DISABLED/.test(src),
    "isGatewayEnabled must check AI_GATEWAY_DISABLED");
});

test("getTextModel routes via isGatewayEnabled(), not a raw token check", () => {
  // The gateway branch inside getTextModel must be gated on isGatewayEnabled().
  const fn = src.slice(src.indexOf("export function getTextModel"));
  assert.ok(/if\s*\(isGatewayEnabled\(\)\)/.test(fn),
    "getTextModel must gate the gateway on isGatewayEnabled()");
  assert.ok(!/if\s*\(process\.env\.VERCEL_OIDC_TOKEN\s*\|\|\s*process\.env\.AI_GATEWAY_API_KEY\)/.test(fn),
    "getTextModel must NOT branch on the raw gateway token (that ignored the disable flag)");
});

test("resolveProviderMode and validateModelConfig also use isGatewayEnabled()", () => {
  const rpm = src.slice(src.indexOf("function resolveProviderMode"), src.indexOf("export const PROVIDER_MODE"));
  assert.ok(/isGatewayEnabled\(\)/.test(rpm),
    "resolveProviderMode must use isGatewayEnabled()");
  const vmc = src.slice(src.indexOf("export function validateModelConfig"));
  assert.ok(/isGatewayEnabled\(\)/.test(vmc.slice(0, 600)),
    "validateModelConfig must use isGatewayEnabled() so a disabled gateway doesn't mask a missing direct key");
});
