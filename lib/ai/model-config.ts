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
 * Provider modes (resolved automatically, or forced via AI_PROVIDER_MODE):
 *   "openai_direct"  — OpenAI API directly (requires OPENAI_API_KEY). Default when key present.
 *   "vercel_gateway" — Vercel AI Gateway via OIDC (requires VERCEL_OIDC_TOKEN).
 *
 * Auto-detection order:
 *   1. AI_PROVIDER_MODE env var if explicitly set.
 *   2. OPENAI_API_KEY present → openai_direct.
 *   3. VERCEL_OIDC_TOKEN present → vercel_gateway.
 *   4. Neither → defaults to openai_direct (will fail gracefully at call time).
 */

import { gateway } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

export function getOpenAIKey(): string | undefined { return process.env.openai_basilv2 ?? process.env.OPENAI_API_KEY; }

// ── Types ─────────────────────────────────────────────────────────────────────

export type ProviderMode = "openai_direct" | "vercel_gateway";
export type ModelKind    = "fast" | "default" | "long";

// ── Model IDs ─────────────────────────────────────────────────────────────────

/** Vercel AI Gateway slugs (provider/model). */
export const GATEWAY_MODEL_IDS = {
  fast:    "anthropic/claude-haiku-4.5",
  default: "anthropic/claude-sonnet-4.6",
  long:    "anthropic/claude-sonnet-4.6",
} as const satisfies Record<ModelKind, string>;

/**
 * OpenAI model IDs.
 * Override via OPENAI_MODEL (default) and OPENAI_MODEL_FAST (fast tier).
 */
export function openaiModelId(kind: ModelKind): string {
  if (kind === "fast") {
    return process.env.OPENAI_MODEL_FAST ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  }
  return process.env.OPENAI_MODEL ?? "gpt-4o";
}

// ── Token defaults ─────────────────────────────────────────────────────────────

export const MAX_TOKENS: Record<ModelKind, number> = {
  fast:    2_048,
  default: 4_096,
  long:    8_192,
};

// ── Provider mode ─────────────────────────────────────────────────────────────

function resolveProviderMode(): ProviderMode {
  const raw = process.env.AI_PROVIDER_MODE;

  if (raw === "openai_direct")  return "openai_direct";
  if (raw === "vercel_gateway") return "vercel_gateway";

  if (raw && raw !== "openai_direct" && raw !== "vercel_gateway") {
    console.warn(
      `[ai/model-config] Unknown AI_PROVIDER_MODE="${raw}". ` +
      `Falling back to auto-detect. Valid values: "openai_direct" | "vercel_gateway".`
    );
  }

  // Auto-detect: prefer OpenAI direct when key is present
  if (getOpenAIKey()) return "openai_direct";
  if (process.env.VERCEL_OIDC_TOKEN) return "vercel_gateway";

  // Neither configured — default to openai_direct; will surface a clean error at call time
  return "openai_direct";
}

/** Active provider mode — exported for observability and the Stig status endpoint. */
export const PROVIDER_MODE: ProviderMode = resolveProviderMode();

// ── Startup validation ────────────────────────────────────────────────────────

/**
 * Assert that the active provider mode is correctly configured.
 * Called from GET /api/system/health so misconfigurations surface early.
 */
export function validateModelConfig(): void {
  if (PROVIDER_MODE === "openai_direct") {
    if (!getOpenAIKey()) {
      throw new Error(
        "[ai/model-config] openai_direct mode requires OPENAI_API_KEY. " +
        "Add it to your Vercel environment variables or .env.local."
      );
    }
    return;
  }

  // vercel_gateway
  if (!process.env.VERCEL_OIDC_TOKEN) {
    throw new Error(
      "[ai/model-config] vercel_gateway mode requires VERCEL_OIDC_TOKEN. " +
      "Run `vercel env pull .env.local` to provision it, or set AI_PROVIDER_MODE=openai_direct " +
      "and add OPENAI_API_KEY instead."
    );
  }
}

// ── Model factory ─────────────────────────────────────────────────────────────

/**
 * Return the LanguageModel for the given tier.
 * Provider is resolved from PROVIDER_MODE — call sites are provider-agnostic.
 *
 * @param kind  "fast" | "default" | "long"  (default: "default")
 */
export function getTextModel(kind: ModelKind = "default"): LanguageModel {
  if (PROVIDER_MODE === "openai_direct") {
    const apiKey = getOpenAIKey();
    if (!apiKey) {
      throw new Error(
        "[ai/model-config] OPENAI_API_KEY is not set. " +
        "Add it in Vercel dashboard → Environment Variables, or set AI_PROVIDER_MODE=vercel_gateway " +
        "and run `vercel env pull .env.local` for VERCEL_OIDC_TOKEN."
      );
    }
    const openai = createOpenAI({ apiKey });
    return openai(openaiModelId(kind));
  }

  // vercel_gateway
  if (!process.env.VERCEL_OIDC_TOKEN) {
    throw new Error(
      "[ai/model-config] VERCEL_OIDC_TOKEN is not set. " +
      "Run `vercel env pull .env.local`, or set OPENAI_API_KEY to use OpenAI direct instead."
    );
  }
  return gateway(GATEWAY_MODEL_IDS[kind] as Parameters<typeof gateway>[0]);
}
