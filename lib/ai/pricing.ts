/**
 * lib/ai/pricing.ts — token → USD cost model for AI spend metering.
 *
 * Costs are keyed by MODEL FAMILY rather than exact model id so that the cap
 * stays correct whether a tier is served by the Vercel AI Gateway, Anthropic
 * direct, or the OpenAI fallback — within a family the per-token price is
 * effectively the same.
 *
 * IMPORTANT: these are list-price ESTIMATES (USD per 1,000,000 tokens) used to
 * bound spend, not to bill customers. Verify against current provider pricing
 * before relying on the absolute numbers; the spend guard only needs them to be
 * the right order of magnitude and correctly ranked (Opus ≫ Sonnet ≫ Haiku).
 *
 * Single source of truth for the tier→family mapping is model-config.ts; this
 * module imports ModelKind from there and exposes familyForTier() as the
 * default (pre plan-aware-tiering) mapping.
 */

import "server-only";
import type { ModelKind } from "./model-config";
import { RESERVE_OUTPUT_TOKENS } from "./model-config";

/** Model families we price. */
export type PriceFamily =
  | "opus" | "opus5" | "sonnet" | "haiku" | "gpt5"
  | "gpt56luna" | "gpt56terra" | "gpt56sol";

/**
 * USD per 1,000,000 tokens. Estimates — see module note.
 * The gpt56* rates are copied from the live ai-gateway.vercel.sh/v1/models
 * listing and back the owner's tiering policy (gather → luna, categorize →
 * terra, reason → sol).
 */
export const FAMILY_PRICING: Record<PriceFamily, { inputPerM: number; outputPerM: number }> = {
  opus:   { inputPerM: 15,   outputPerM: 75 }, // claude-opus-4.8
  // claude-opus-5 — the PRIMARY model for the mid + top tiers as of 2026-07-23.
  // Rates read straight off the live gateway listing ($5/M in, $25/M out): it is
  // cheaper on output than gpt-5.6-sol ($30) and far cheaper than opus-4.8.
  opus5:  { inputPerM: 5,    outputPerM: 25 },
  sonnet: { inputPerM: 3,    outputPerM: 15 }, // claude-sonnet-4.x / sonnet-5
  haiku:  { inputPerM: 1,    outputPerM: 5 },  // claude-haiku-4.5
  gpt5:   { inputPerM: 1.25, outputPerM: 10 }, // gpt-5.4 (legacy OpenAI fallback)
  gpt56luna:  { inputPerM: 1,   outputPerM: 6 },  // data gathering
  gpt56terra: { inputPerM: 2.5, outputPerM: 15 }, // categorization
  gpt56sol:   { inputPerM: 5,   outputPerM: 30 }, // contextual + reasoning (incl. the pinned assistant)
};

/**
 * Price family for the pinned assistant model (Ask Basil). Chat call sites use
 * this INSTEAD of familyForTier(), because the assistant's model is pinned
 * rather than tier-resolved.
 */
export const CHAT_PRICE_FAMILY: PriceFamily = "opus5";

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/** Compute the USD cost of a single call for the given family + token usage. */
export function costUsd(family: PriceFamily, usage: TokenUsage | undefined): number {
  const p = FAMILY_PRICING[family];
  const inTok = Math.max(0, usage?.inputTokens ?? 0);
  const outTok = Math.max(0, usage?.outputTokens ?? 0);
  return (inTok / 1_000_000) * p.inputPerM + (outTok / 1_000_000) * p.outputPerM;
}

/**
 * Family for a tier, matching model-config routing:
 *   fast → Haiku, balanced → Sonnet, default/long → Opus.
 * Plan-aware down-tiering (Sprint 3 #4) resolves the effective tier first
 * (see lib/ai/tiering.ts) and the resulting family flows to the spend guard.
 */
export function familyForTier(kind: ModelKind): PriceFamily {
  // Mirrors ANTHROPIC_MODEL_IDS, which is the PRIMARY path as of 2026-07-23
  // (Anthropic-direct): fast → haiku, balanced/default/long → opus-5.
  // If the OpenAI fallback runs instead its rates (luna $1/$6, terra $2.5/$15,
  // sol $5/$30) sit at or near these, so the reservation stays sane either way.
  // NOTE: the assistant (Ask Basil) does NOT price via this — its model is
  // pinned, so it uses CHAT_PRICE_FAMILY.
  switch (kind) {
    case "fast": return "haiku";      // basic data gathering
    case "balanced": return "opus5";  // categorization (opus-5 @ effort low)
    case "default":
    case "long": return "opus5";      // contextual + reasoning (opus-5 @ effort high)
  }
}

/**
 * Conservative worst-case input-token estimate used when reserving budget
 * before a call (we don't know the real prompt size cheaply at reserve time).
 * Covers the ~18K context-input budget plus system prompt + tools headroom.
 */
export const WORST_CASE_INPUT_TOKENS = 24_000;

/**
 * Worst-case USD for a tier — used to RESERVE budget before a call runs.
 *
 * Uses RESERVE_OUTPUT_TOKENS, NOT the MAX_TOKENS ceiling. Those were the same
 * number until the GPT-5.6 (reasoning) switch forced the ceiling up to leave
 * room for reasoning tokens: reserving at that ceiling × 8 steps would hold
 * ~$7.68 for one chat message and 429 the user off their own cap. The real cost
 * is reconciled from actual usage by commitSpend() immediately after the call,
 * so this only has to be a sane pre-flight estimate.
 */
export function worstCaseCostUsd(kind: ModelKind, family: PriceFamily): number {
  return costUsd(family, {
    inputTokens: WORST_CASE_INPUT_TOKENS,
    outputTokens: RESERVE_OUTPUT_TOKENS[kind],
  });
}
