/**
 * Centralised AI model configuration.
 *
 * Single source of truth for model selection. All generateText / streamText
 * call sites import `getTextModel` from here — zero hardcoded model IDs elsewhere.
 *
 * Usage:
 *   import { getTextModel } from "@/lib/ai/model-config";
 *
 *   const { text } = await generateText({
 *     model: getTextModel("fast"),    // classification tasks
 *     model: getTextModel(),          // "default" — chat, briefing, digests
 *     model: getTextModel("long"),    // high-output generation
 *   });
 *
 * Provider:
 *   Always routes through the Vercel AI Gateway using OIDC authentication.
 *   VERCEL_OIDC_TOKEN is auto-injected on every Vercel deployment — no manual
 *   key management needed in production.
 *
 *   Locally:  run `vercel env pull .env.local` to provision a short-lived token.
 *   Override: set AI_GATEWAY_API_KEY for non-Vercel/CI environments.
 */

import { gateway } from "ai";
import type { LanguageModel } from "ai";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ModelKind = "fast" | "default" | "long";

// Keep ProviderMode as a string alias for back-compat with call sites that read it
export type ProviderMode = "vercel_gateway";
export const PROVIDER_MODE: ProviderMode = "vercel_gateway";

// ── Model IDs ─────────────────────────────────────────────────────────────────

/**
 * Vercel AI Gateway model slugs — "provider/model" with dots for version segments.
 * Anthropic Claude routes through the gateway for observability and failover.
 */
export const GATEWAY_MODEL_IDS = {
  fast:    "anthropic/claude-haiku-4.5",
  default: "anthropic/claude-sonnet-4.6",
  long:    "anthropic/claude-sonnet-4.6",
} as const satisfies Record<ModelKind, string>;

// ── Token defaults ─────────────────────────────────────────────────────────────

export const MAX_TOKENS: Record<ModelKind, number> = {
  fast:    2_048,
  default: 4_096,
  long:    8_192,
};

// ── Startup validation ────────────────────────────────────────────────────────

/**
 * Assert that the gateway is reachable.
 * Called from GET /api/system/health so misconfigurations surface early.
 */
export function validateModelConfig(): void {
  if (!process.env.VERCEL_OIDC_TOKEN && !process.env.AI_GATEWAY_API_KEY) {
    throw new Error(
      "[ai/model-config] No gateway credentials found. " +
      "Run `vercel env pull .env.local` to provision VERCEL_OIDC_TOKEN locally, " +
      "or set AI_GATEWAY_API_KEY for non-Vercel environments. " +
      "In production on Vercel, VERCEL_OIDC_TOKEN is injected automatically."
    );
  }
}

// ── Helpers kept for call-sites that imported them ────────────────────────────

/** @deprecated — use getTextModel() directly; provider mode is always vercel_gateway */
export function getOpenAIKey(): string | undefined { return undefined; }

// ── Model factory ─────────────────────────────────────────────────────────────

/**
 * Return the LanguageModel for the given tier via the Vercel AI Gateway.
 *
 * @param kind  "fast" | "default" | "long"  (default: "default")
 */
export function getTextModel(kind: ModelKind = "default"): LanguageModel {
  if (!process.env.VERCEL_OIDC_TOKEN && !process.env.AI_GATEWAY_API_KEY) {
    throw new Error(
      "[ai/model-config] No gateway credentials. " +
      "Run `vercel env pull .env.local` to provision VERCEL_OIDC_TOKEN. " +
      "On Vercel deployments this is injected automatically."
    );
  }
  return gateway(GATEWAY_MODEL_IDS[kind] as Parameters<typeof gateway>[0]);
}
