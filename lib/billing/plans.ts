/**
 * lib/billing/plans.ts — plan / entitlement model (provider-agnostic).
 *
 * The commercial model (chosen Sprint 3): a Free tier, one paid tier (Pro), and
 * a 14-day trial that grants Pro. Entitlements are intentionally provider-
 * agnostic: a future Stripe (or merchant-of-record) integration maps a price ID
 * to one of these plans, and everything downstream keys off the Entitlement —
 * never off a Stripe object directly.
 *
 * KEY ALIGNMENT: each plan's `aiMonthlyUsd` is the SAME unit the AI spend guard
 * (lib/ai/spend-guard.ts) meters, so "your plan's AI quota" and "your spend cap"
 * are one number, not two systems that can disagree.
 *
 * This module is pure data + helpers — safe to import anywhere (no I/O).
 */

export type Plan = "free" | "pro";

/** Lifecycle status of a user's subscription. */
export type PlanStatus = "active" | "trialing" | "past_due" | "canceled";

/** Feature flags + numeric limits granted by a plan. */
export interface PlanFeatures {
  /** Interactive AI chat (Ask Basil). */
  aiChat: boolean;
  /** Daily briefings + digests (the expensive unattended Opus workloads). */
  briefings: boolean;
  /** Meeting prep generation. */
  meetingPrep: boolean;
  /** Max connected integrations (-1 = unlimited). */
  maxIntegrations: number;
}

/** A user's resolved billing entitlement. */
export interface Entitlement {
  plan: Plan;
  status: PlanStatus;
  /** Monthly AI spend quota in USD — feeds the per-user spend cap. */
  aiMonthlyUsd: number;
  features: PlanFeatures;
  /** ISO timestamp the trial ends (only when status === "trialing"). */
  trialEndsAt?: string;
  /** ISO timestamp the current paid period / access ends. */
  currentPeriodEnd?: string;
  /** Which provider owns this subscription (filled once a real provider wires in). */
  provider?: "stub" | "stripe";
  customerId?: string;
  subscriptionId?: string;
  /** ISO timestamp of the last mutation. */
  updatedAt: string;
}

/** Feature keys usable with the paywall's requireEntitlement(). */
export type Feature = keyof PlanFeatures;

/** Trial configuration. */
export const TRIAL_DAYS = 14;
export const TRIAL_PLAN: Plan = "pro";

/** Per-plan capability definitions. */
export const PLAN_DEFS: Record<Plan, { aiMonthlyUsd: number; features: PlanFeatures }> = {
  free: {
    aiMonthlyUsd: 2,
    features: { aiChat: true, briefings: false, meetingPrep: false, maxIntegrations: 2 },
  },
  pro: {
    aiMonthlyUsd: 50,
    features: { aiChat: true, briefings: true, meetingPrep: true, maxIntegrations: -1 },
  },
};

/** Human-facing plan metadata (prices are placeholders — owner sets real ones). */
export const PLAN_LABELS: Record<Plan, { name: string; priceUsdMonthly: number | null }> = {
  free: { name: "Free", priceUsdMonthly: 0 },
  pro: { name: "Pro", priceUsdMonthly: null }, // null = price not yet configured
};

/** Build an Entitlement for a plan at a given status. */
export function entitlementForPlan(
  plan: Plan,
  status: PlanStatus = "active",
  extra: Partial<Entitlement> = {}
): Entitlement {
  const def = PLAN_DEFS[plan];
  return {
    plan,
    status,
    aiMonthlyUsd: def.aiMonthlyUsd,
    features: { ...def.features },
    updatedAt: nowIso(),
    ...extra,
  };
}

/** The entitlement every user starts on — Free, active. */
export function defaultEntitlement(): Entitlement {
  return entitlementForPlan("free", "active");
}

/**
 * Unlimited internal entitlement for platform admins / the SKIP_AUTH dev user,
 * so the owner's own usage is never paywalled. Generous (not infinite) AI quota
 * so the spend guard still records and bounds runaway loops.
 */
export function adminEntitlement(): Entitlement {
  return {
    plan: "pro",
    status: "active",
    aiMonthlyUsd: 1000,
    features: { aiChat: true, briefings: true, meetingPrep: true, maxIntegrations: -1 },
    updatedAt: nowIso(),
  };
}

export function nowIso(): string {
  return new Date().toISOString();
}
