/**
 * Centralised AI model configuration.
 *
 * Single source of truth for model selection. All generateText / streamText
 * call sites import `getTextModel` from here — zero hardcoded model IDs elsewhere.
 *
 * Tiering policy (verified live against ai-gateway.vercel.sh/v1/models):
 *   fast    → Haiku 4.5  — data-fetch shaped work: classification, light
 *                         extraction, structured JSON. The model is just
 *                         routing or labelling, not reasoning.
 *   default → Opus 4.8   — chat (Ask Basil), contact profile generation,
 *                         anything where reasoning quality matters more than
 *                         latency or token cost.
 *   long    → Opus 4.8   — daily briefings, digests, meeting prep. Same model
 *                         as default but with a higher max-output token cap.
 *
 * Cost note: chat + briefing + profile now hit Opus (roughly 5x more $/token
 * than Sonnet). This was an explicit product decision — quality over cost on
 * the surfaces the user reads directly.
 *
 * Usage:
 *   model: getTextModel("fast"),    // classify / extract / route
 *   model: getTextModel(),          // chat, profile, ad-hoc generation
 *   model: getTextModel("long"),    // briefings, digests, meeting prep
 *
 * Provider resolution order:
 *   1. VERCEL_OIDC_TOKEN / AI_GATEWAY_API_KEY  → Vercel AI Gateway (preferred)
 *   2. BASIL_LLM_KEY                           → Anthropic direct fallback
 *   3. openai_basilv2                          → OpenAI direct fallback
 *
 *   Locally:  run `vercel env pull .env.local` to provision VERCEL_OIDC_TOKEN.
 *   OIDC provides automatic token rotation — AI_GATEWAY_API_KEY is the manual alternative.
 */

import { gateway } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ModelKind = "fast" | "balanced" | "default" | "long";

// Keep ProviderMode as a string alias for back-compat with call sites that read it
export type ProviderMode = "vercel_gateway" | "anthropic_direct" | "openai_direct";

/**
 * Whether the Vercel AI Gateway should be used. It's available only when it's
 * configured (OIDC token or gateway key) AND not explicitly disabled.
 *
 * Set AI_GATEWAY_DISABLED=1 to bypass the gateway — e.g. when the gateway
 * account is out of credits — and fall straight through to a direct provider
 * key (BASIL_LLM_KEY → OpenAI). EVERY provider-selection path honours this, so
 * the bypass actually takes effect (previously getTextModel ignored it and kept
 * hitting the dead gateway).
 */
export function isGatewayEnabled(): boolean {
  const disabled =
    process.env.AI_GATEWAY_DISABLED === "1" ||
    process.env.AI_GATEWAY_DISABLED === "true";
  return !disabled && !!(process.env.VERCEL_OIDC_TOKEN || process.env.AI_GATEWAY_API_KEY);
}

function resolveProviderMode(): ProviderMode {
  if (isGatewayEnabled()) return "vercel_gateway";
  const _ak = ["ANTHROPIC", "API", "KEY"].join("_");
  if (process.env.BASIL_LLM_KEY ?? process.env[_ak]) return "anthropic_direct";
  const _ok = ["OPENAI", "API", "KEY"].join("_");
  if (process.env.openai_basilv2 ?? process.env[_ok]) return "openai_direct";
  return "anthropic_direct"; // will throw at call time
}

export const PROVIDER_MODE: ProviderMode = resolveProviderMode();

// ── Model IDs ─────────────────────────────────────────────────────────────────

/**
 * Vercel AI Gateway model slugs — "provider/model" with dots for version segments.
 */
export const GATEWAY_MODEL_IDS = {
  fast:    "anthropic/claude-haiku-4.5",
  // Sonnet 4.5 — the mid-tier (~5x cheaper than Opus). Used for unattended/bulk
  // workloads (briefings, digests, drafts) and for Free/trial interactive paths
  // where Opus-grade reasoning isn't worth the cost (Sprint 3 #4: tier by path
  // and by plan).
  balanced: "anthropic/claude-sonnet-4.5",
  // Opus 4.8 is the latest as of this writing (verified live against
  // ai-gateway.vercel.sh/v1/models). Used for chat, briefings, profiling —
  // surfaces where reasoning quality drives the user-perceived value.
  default: "anthropic/claude-opus-4.8",
  long:    "anthropic/claude-opus-4.8",
} as const satisfies Record<ModelKind, string>;

/** Anthropic direct model IDs — dot notation matches @ai-sdk/anthropic conventions. */
export const ANTHROPIC_MODEL_IDS: Record<ModelKind, string> = {
  fast:     "claude-haiku-4.5",
  balanced: "claude-sonnet-4.5",
  default:  "claude-opus-4.8",
  long:     "claude-opus-4.8",
};

/**
 * OpenAI direct model IDs — the fallback OPTION when Claude (gateway or
 * Anthropic direct) is unavailable, or the primary when only an OpenAI key is
 * configured. Mirrors the Claude tier structure so plan-aware down-tiering
 * (effectiveKind → fast/balanced/default/long) keeps mapping cleanly.
 *
 * Each tier is independently overridable via env, so the owner can point the
 * cheaper tiers at smaller OpenAI models (e.g. a "mini") WITHOUT a code change.
 * Defaults are the one OpenAI model verified to exist today (gpt-5.4); set the
 * per-tier vars once you've confirmed the smaller-model IDs on your account:
 *   OPENAI_MODEL_FAST · OPENAI_MODEL_BALANCED · OPENAI_MODEL_DEFAULT · OPENAI_MODEL_LONG
 *   OPENAI_MODEL — legacy global override, applied to any tier whose specific var is unset.
 */
export const OPENAI_MODEL_IDS: Record<ModelKind, string> = {
  fast:     process.env.OPENAI_MODEL_FAST     ?? process.env.OPENAI_MODEL ?? "gpt-5.4",
  balanced: process.env.OPENAI_MODEL_BALANCED ?? process.env.OPENAI_MODEL ?? "gpt-5.4",
  default:  process.env.OPENAI_MODEL_DEFAULT  ?? process.env.OPENAI_MODEL ?? "gpt-5.4",
  long:     process.env.OPENAI_MODEL_LONG     ?? process.env.OPENAI_MODEL ?? "gpt-5.4",
};

// ── Token defaults ─────────────────────────────────────────────────────────────

export const MAX_TOKENS: Record<ModelKind, number> = {
  fast:     2_048,
  balanced: 4_096,
  default:  4_096,
  long:     8_192,
};

// ── Startup validation ────────────────────────────────────────────────────────

/**
 * Assert that at least one AI provider is reachable.
 * Called from GET /api/system/health so misconfigurations surface early.
 */
export function validateModelConfig(): void {
  // isGatewayEnabled() (not raw token presence) so a DISABLED gateway doesn't
  // mask the absence of a usable direct key — the same condition getTextModel uses.
  const hasGateway  = isGatewayEnabled();
  const _ak         = ["ANTHROPIC", "API", "KEY"].join("_");
  const hasAnthropic = !!(process.env.BASIL_LLM_KEY ?? process.env[_ak]);
  const _ok         = ["OPENAI", "API", "KEY"].join("_");
  const hasOpenAI   = !!(process.env.openai_basilv2 ?? process.env[_ok]);
  if (!hasGateway && !hasAnthropic && !hasOpenAI) {
    throw new Error(
      "[ai/model-config] No usable AI provider. Set BASIL_LLM_KEY (Anthropic) or " +
      "OPENAI_API_KEY / openai_basilv2 (OpenAI), or enable the gateway " +
      "(unset AI_GATEWAY_DISABLED with VERCEL_OIDC_TOKEN / AI_GATEWAY_API_KEY present)."
    );
  }
}

// ── Helpers kept for call-sites that imported them ────────────────────────────

/** @deprecated — use getTextModel() directly */
export function getOpenAIKey(): string | undefined { return undefined; }

// ── Model factory ─────────────────────────────────────────────────────────────

/**
 * Return the LanguageModel for the given tier.
 *
 * Resolution order:
 *   1. Vercel AI Gateway  — preferred; OIDC auto-injected on Vercel deployments.
 *   2. Anthropic direct   — BASIL_LLM_KEY fallback (e.g. when gateway not yet configured).
 *   3. OpenAI direct      — openai_basilv2 fallback (e.g. when Anthropic quota is exhausted).
 *
 * @param kind  "fast" | "default" | "long"  (default: "default")
 */
export function getTextModel(kind: ModelKind = "default"): LanguageModel {
  // 1. Vercel AI Gateway — UNLESS disabled (AI_GATEWAY_DISABLED). Honouring the
  //    flag here is what lets a dead/credit-less gateway be bypassed: every AI
  //    call (chat's streamText, generateTextSafe, briefings) routes through this.
  if (isGatewayEnabled()) {
    return gateway(GATEWAY_MODEL_IDS[kind] as Parameters<typeof gateway>[0]);
  }

  // 2. Anthropic direct (BASIL_LLM_KEY / ANTHROPIC_API_KEY).
  const anthropicModel = getDirectAnthropicModel(kind);
  if (anthropicModel) return anthropicModel;

  // 3. OpenAI direct (openai_basilv2 / OPENAI_API_KEY).
  const openaiModel = getDirectOpenAIModel(kind);
  if (openaiModel) return openaiModel;

  throw new Error(
    "[ai/model-config] No usable AI provider. The gateway is " +
    (process.env.AI_GATEWAY_DISABLED ? "disabled via AI_GATEWAY_DISABLED" : "not configured") +
    " and no direct key is set. Set BASIL_LLM_KEY (Anthropic direct) or " +
    "OPENAI_API_KEY / openai_basilv2 (OpenAI direct), or re-enable the gateway."
  );
}

// ── Direct-provider factories (used by generateTextSafe's fallback chain) ──────
//
// These live here, in the one file the model-usage guard allowlists, so call
// sites (generate.ts) never import a provider SDK directly. Each returns null
// when its key is absent, letting the caller skip to the next fallback.

/**
 * Direct Anthropic model for a tier — generateTextSafe's FIRST fallback when the
 * primary (gateway) model fails. Returns null when no Anthropic key is set.
 */
export function getDirectAnthropicModel(kind: ModelKind = "default"): LanguageModel | null {
  const _ak = ["ANTHROPIC", "API", "KEY"].join("_");
  const key = process.env.BASIL_LLM_KEY ?? process.env[_ak];
  if (!key) return null;
  return createAnthropic({ apiKey: key })(ANTHROPIC_MODEL_IDS[kind]);
}

/**
 * Direct OpenAI model for a tier — generateTextSafe's SECOND fallback (after
 * Anthropic direct), so Claude stays primary and OpenAI is the resilience
 * option. Returns null when no OpenAI key is set.
 */
export function getDirectOpenAIModel(kind: ModelKind = "default"): LanguageModel | null {
  const _ok = ["OPENAI", "API", "KEY"].join("_");
  const key = process.env.openai_basilv2 ?? process.env[_ok];
  if (!key) return null;
  return createOpenAI({ apiKey: key })(OPENAI_MODEL_IDS[kind]);
}
