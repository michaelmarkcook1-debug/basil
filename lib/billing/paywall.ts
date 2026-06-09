/**
 * lib/billing/paywall.ts — feature gating composed on top of auth.
 *
 * requireEntitlement() is the billing analogue of requireUser(): call it in a
 * route handler to enforce that the user's plan includes a feature, and convert
 * EntitlementRequiredError → HTTP 402 in the catch.
 *
 *   import { requireEntitlement, EntitlementRequiredError } from "@/lib/billing/paywall";
 *   try {
 *     const username = await requireUser();
 *     await requireEntitlement(username, "briefings");
 *     // ...
 *   } catch (err) {
 *     if (err instanceof EntitlementRequiredError)
 *       return NextResponse.json({ error: "Upgrade required", feature: err.feature }, { status: 402 });
 *     if (err instanceof AuthRequiredError)
 *       return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
 *     throw err;
 *   }
 *
 * Everyone defaults to Free, so this never crashes pre-provider; it only blocks
 * features a Free plan doesn't include.
 *
 * server-only.
 */

import "server-only";
import { getEntitlement } from "./entitlement-store";
import { type Feature, type Plan } from "./plans";

export class EntitlementRequiredError extends Error {
  readonly status = 402;
  constructor(public readonly feature: Feature) {
    super(`Plan upgrade required for: ${feature}`);
    this.name = "EntitlementRequiredError";
  }
}

/** True when the user's plan includes a boolean feature. */
export async function hasFeature(username: string, feature: Feature): Promise<boolean> {
  const ent = await getEntitlement(username);
  const value = ent.features[feature];
  return typeof value === "number" ? value !== 0 : Boolean(value);
}

/** Throw EntitlementRequiredError (402) when the user's plan lacks a feature. */
export async function requireEntitlement(username: string, feature: Feature): Promise<void> {
  if (!(await hasFeature(username, feature))) {
    throw new EntitlementRequiredError(feature);
  }
}

/** The user's current plan tier — used by plan-aware model tiering (#4). */
export async function getPlan(username: string): Promise<Plan> {
  return (await getEntitlement(username)).plan;
}

/** The user's per-month AI USD quota — feeds the spend guard's per-user cap. */
export async function getAiMonthlyUsd(username: string): Promise<number> {
  return (await getEntitlement(username)).aiMonthlyUsd;
}
