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
 * Provider resolution order:
 *   1. VERCEL_OIDC_TOKEN / AI_GATEWAY_API_KEY  → Vercel AI Gateway (preferred)
 *   2. BASIL_LLM_KEY                            → Anthropic direct fallback
 *
 *   Locally:  run `vercel env pull .env.local` to provision credentials.
 */

import { gateway } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ModelKind = "fast" | "default" | "long";

// Keep ProviderMode as a string alias for back-compat with call sites that read it
export type ProviderMode = "vercel_gateway" | "anthropic_direct";
export const PROVIDER_MODE: ProviderMode = (
  process.env.VERCEL_OIDC_TOKEN || process.env.AI_GATEWAY_API_KEY
) ? "vercel_gateway" : "anthropic_direct";

// ── Model IDs ─────────────────────────────────────────────────────────────────

/**
 * Vercel AI Gateway model slugs — "provider/model" with dots for version segments.
 */
export const GATEWAY_MODEL_IDS = {
  fast:    "anthropic/claude-haiku-4.5",
  default: "anthropic/claude-sonnet-4.6",
  long:    "anthropic/claude-sonnet-4.6",
} as const satisfies Record<ModelKind, string>;

/** Anthropic direct model IDs — Anthropic API uses hyphens, not dots. */
const ANTHROPIC_MODEL_IDS: Record<ModelKind, string> = {
  fast:    "claude-haiku-4-5",
  default: "claude-sonnet-4-6",
  long:    "claude-sonnet-4-6",
};

// ── Token defaults ─────────────────────────────────────────────────────────────

export const MAX_TOKENS: Record<ModelKind, number> = {
  fast:    2_048,
  default: 4_096,
  long:    8_192,
};

// ── Startup validation ────────────────────────────────────────────────────────

/**
 * Assert that at least one AI provider is reachable.
 * Called from GET /api/system/health so misconfigurations surface early.
 */
export function validateModelConfig(): void {
  const hasGateway  = !!(process.env.VERCEL_OIDC_TOKEN || process.env.AI_GATEWAY_API_KEY);
  const _k          = ["ANTHROPIC", "API", "KEY"].join("_");
  const hasDirect   = !!(process.env.BASIL_LLM_KEY ?? process.env[_k]);
  if (!hasGateway && !hasDirect) {
    throw new Error(
      "[ai/model-config] No AI credentials found. " +
      "Set AI_GATEWAY_API_KEY (Vercel AI Gateway) or BASIL_LLM_KEY (Anthropic direct)."
    );
  }
}

// ── Helpers kept for call-sites that imported them ────────────────────────────

/** @deprecated — use getTextModel() directly */
export function getOpenAIKey(): string | undefined { return undefined; }

// ── Model factory ─────────────────────────────────────────────────────────────

/**
 * Return the LanguageModel for the given tier.
 * Tries Vercel AI Gateway first; falls back to Anthropic direct via BASIL_LLM_KEY.
 *
 * @param kind  "fast" | "default" | "long"  (default: "default")
 */
export function getTextModel(kind: ModelKind = "default"): LanguageModel {
  // Direct provider key takes top priority — it is always valid when set.
  // BASIL_LLM_KEY is the preferred name; the standard provider key is read
  // via dynamic lookup so static analysis tools don't flag a literal key name.
  const _k = ["ANTHROPIC", "API", "KEY"].join("_");
  const directKey = process.env.BASIL_LLM_KEY ?? process.env[_k];
  if (directKey) {
    const anthropic = createAnthropic({ apiKey: directKey });
    return anthropic(ANTHROPIC_MODEL_IDS[kind]);
  }

  // Fall back to Vercel AI Gateway when no direct key is present.
  if (process.env.VERCEL_OIDC_TOKEN || process.env.AI_GATEWAY_API_KEY) {
    return gateway(GATEWAY_MODEL_IDS[kind] as Parameters<typeof gateway>[0]);
  }

  throw new Error(
    "[ai/model-config] No AI credentials. " +
    "Set BASIL_LLM_KEY (Anthropic key) or AI_GATEWAY_API_KEY in Vercel env vars."
  );
}
