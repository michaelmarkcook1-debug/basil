/**
 * Centralised AI model configuration.
 *
 * Single source of truth for model selection.  All generateText / streamText
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
 * Provider modes (set via AI_PROVIDER_MODE env var):
 *   "vercel_gateway"   — Vercel AI Gateway via OIDC (default, recommended)
 *   "anthropic_direct" — reserved; throws at startup with setup instructions
 */

import { gateway } from "ai";
import type { LanguageModel } from "ai";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ProviderMode = "anthropic_direct" | "vercel_gateway";
export type ModelKind    = "fast" | "default" | "long";

// ── Model IDs ─────────────────────────────────────────────────────────────────

/**
 * Gateway slug format: "provider/model-name-major.minor"
 * Update versions here when upgrading — do not touch call sites.
 */
export const GATEWAY_MODEL_IDS = {
  /** Haiku — fast classification tasks (email, Slack, Zoom message triage). */
  fast:    "anthropic/claude-haiku-4.5",
  /** Sonnet — balanced generation (chat, briefing, digest, contacts). */
  default: "anthropic/claude-sonnet-4.6",
  /** Sonnet — same model, higher output budget for long-form generation. */
  long:    "anthropic/claude-sonnet-4.6",
} as const satisfies Record<ModelKind, string>;

// ── Token defaults ─────────────────────────────────────────────────────────────

export const MAX_TOKENS: Record<ModelKind, number> = {
  fast:    2_048,
  default: 4_096,
  long:    8_192,
};

// ── Provider mode ─────────────────────────────────────────────────────────────

function resolveProviderMode(): ProviderMode {
  const raw = process.env.AI_PROVIDER_MODE;
  if (!raw || raw === "vercel_gateway") return "vercel_gateway";
  if (raw === "anthropic_direct") return "anthropic_direct";
  throw new Error(
    `[ai/model-config] Unknown AI_PROVIDER_MODE="${raw}". ` +
    `Expected "vercel_gateway" (default) or "anthropic_direct".`
  );
}

/** Active provider mode — exported for tests and observability. */
export const PROVIDER_MODE: ProviderMode = resolveProviderMode();

// ── Startup validation ────────────────────────────────────────────────────────

/**
 * Assert that the active provider mode is correctly configured.
 * Call from GET /api/system/health so misconfigurations surface at startup.
 */
export function validateModelConfig(): void {
  if (PROVIDER_MODE === "anthropic_direct") {
    throw new Error(
      "[ai/model-config] anthropic_direct mode is not supported in this deployment. " +
      "Remove AI_PROVIDER_MODE from your environment (defaults to vercel_gateway), " +
      "then run `vercel env pull .env.local` to obtain a VERCEL_OIDC_TOKEN."
    );
  }

  // Primary: OIDC token provisioned by `vercel env pull .env.local` (auto-rotated).
  if (!process.env.VERCEL_OIDC_TOKEN) {
    throw new Error(
      "[ai/model-config] vercel_gateway mode requires VERCEL_OIDC_TOKEN. " +
      "Run `vercel env pull .env.local` to provision it automatically via OIDC."
    );
  }
}

// ── Model factory ─────────────────────────────────────────────────────────────

/**
 * Return the LanguageModel for the given tier via the Vercel AI Gateway.
 *
 * @param kind  "fast" | "default" | "long"  (default: "default")
 */
export function getTextModel(kind: ModelKind = "default"): LanguageModel {
  if (PROVIDER_MODE === "anthropic_direct") {
    throw new Error(
      "[ai/model-config] anthropic_direct mode is not supported. " +
      "Set AI_PROVIDER_MODE=vercel_gateway and run `vercel env pull .env.local`."
    );
  }
  return gateway(GATEWAY_MODEL_IDS[kind] as Parameters<typeof gateway>[0]);
}
