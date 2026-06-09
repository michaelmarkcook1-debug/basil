/**
 * lib/billing/entitlement-store.ts — per-user entitlement persistence.
 *
 * Stored at  users/<username>/entitlement.json  — a SEPARATE blob, deliberately
 * NOT on the AES-encrypted User[] array. Reason: subscription webhooks mutate
 * this frequently, and writing it to the encrypted user array would rewrite and
 * re-encrypt EVERY user's record on every billing event.
 *
 * Trial expiry is resolved on READ: a "trialing" entitlement whose trialEndsAt
 * has passed is reported as downgraded to Free until a real webhook confirms a
 * paid subscription (the stored record is also corrected lazily).
 *
 * server-only.
 */

import "server-only";
import { readUserStore, writeUserStore } from "@/lib/storage/user-store";
import { isAdminUser } from "@/lib/users";
import {
  type Entitlement,
  type Plan,
  type PlanStatus,
  defaultEntitlement,
  adminEntitlement,
  entitlementForPlan,
  TRIAL_DAYS,
  TRIAL_PLAN,
  nowIso,
} from "./plans";

const FILE = "entitlement.json";

/** Resolve trial expiry: an expired trial reads as Free until renewed. */
function resolveTrial(ent: Entitlement): Entitlement {
  if (ent.status === "trialing" && ent.trialEndsAt) {
    const ended = Date.parse(ent.trialEndsAt);
    if (Number.isFinite(ended) && ended <= Date.now()) {
      return { ...defaultEntitlement(), updatedAt: ent.updatedAt };
    }
  }
  return ent;
}

/**
 * The user's current entitlement. Admins/dev get an unlimited internal
 * entitlement; everyone else defaults to Free until a stored record exists.
 */
export async function getEntitlement(username: string): Promise<Entitlement> {
  if (isAdminUser(username)) return adminEntitlement();
  const stored = await readUserStore<Entitlement | null>(username, FILE, null);
  if (!stored || typeof stored !== "object") return defaultEntitlement();
  return resolveTrial(stored);
}

/** Persist an entitlement (stamps updatedAt). */
export async function setEntitlement(username: string, ent: Entitlement): Promise<void> {
  await writeUserStore(username, FILE, { ...ent, updatedAt: nowIso() });
}

/** Start a 14-day Pro trial for a user (idempotent — won't restart an active trial). */
export async function startTrial(username: string): Promise<Entitlement> {
  const current = await getEntitlement(username);
  if (current.status === "trialing" || current.plan === "pro") return current;
  const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const ent = entitlementForPlan(TRIAL_PLAN, "trialing", { trialEndsAt, currentPeriodEnd: trialEndsAt, provider: "stub" });
  await setEntitlement(username, ent);
  return ent;
}

/** Activate a paid plan (called from a confirmed checkout / webhook). */
export async function activatePlan(
  username: string,
  plan: Plan,
  opts: { customerId?: string; subscriptionId?: string; currentPeriodEnd?: string; provider?: "stub" | "stripe" } = {}
): Promise<Entitlement> {
  const ent = entitlementForPlan(plan, "active", opts);
  await setEntitlement(username, ent);
  return ent;
}

/** Mark a subscription past_due (payment failure → dunning). */
export async function markPastDue(username: string): Promise<Entitlement> {
  const current = await getEntitlement(username);
  const ent: Entitlement = { ...current, status: "past_due" as PlanStatus, updatedAt: nowIso() };
  await setEntitlement(username, ent);
  return ent;
}

/** Cancel / downgrade to Free. */
export async function cancelPlan(username: string): Promise<Entitlement> {
  const ent = defaultEntitlement();
  await setEntitlement(username, ent);
  return ent;
}
