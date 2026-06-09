/**
 * lib/ai/tiering.ts — plan-aware model tier selection (Sprint 3 #4).
 *
 * Two levers on AI cost (Opus is ~5x Sonnet per token):
 *
 *   BY PATH  — unattended/bulk workloads (briefings, digests, drafts) call
 *              getTextModel("balanced") directly to use Sonnet instead of Opus.
 *              That's a static choice at the call site, not handled here.
 *
 *   BY PLAN  — interactive paths (chat) down-tier for Free/trial users so Opus
 *              is reserved for paid usage. effectiveKind() applies that here:
 *              a Free user's "default"/"long" request is served by "balanced"
 *              (Sonnet); "fast" stays "fast". Pro/admin keep the full tier.
 *
 * The effective ModelKind is fed to BOTH getTextModel() (which model to call)
 * AND the spend guard (which price family to meter), so cost accounting always
 * matches the model actually used.
 */

import "server-only";
import type { ModelKind } from "./model-config";
import { familyForTier, type PriceFamily } from "./pricing";
import type { Plan } from "@/lib/billing/plans";

/**
 * Resolve the tier a given plan actually gets for a requested base tier.
 * Free/trial-less users get Sonnet on the premium interactive tiers; Pro keeps
 * Opus. "fast" and "balanced" are unchanged (already cheap).
 */
export function effectiveKind(baseKind: ModelKind, plan: Plan): ModelKind {
  if (plan === "pro") return baseKind;
  // Free: down-tier the expensive Opus tiers to Sonnet.
  if (baseKind === "default" || baseKind === "long") return "balanced";
  return baseKind;
}

/** Price family for the effective tier — pass into the spend meter. */
export function familyForKind(kind: ModelKind): PriceFamily {
  return familyForTier(kind);
}
