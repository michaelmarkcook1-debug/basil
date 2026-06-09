import { NextResponse } from "next/server";
import { requireUser, AuthRequiredError } from "@/lib/auth";
import { getEntitlement } from "@/lib/billing/entitlement-store";
import { PLAN_DEFS, PLAN_LABELS } from "@/lib/billing/plans";
import { isLiveBilling } from "@/lib/billing/provider";

/**
 * GET /api/billing/status
 *
 * The current user's entitlement plus plan catalogue — backs the Billing tab.
 * Renders correctly against stub data with no live provider configured.
 */
export async function GET() {
  try {
    const username = await requireUser();
    const entitlement = await getEntitlement(username);
    return NextResponse.json({
      entitlement,
      plans: PLAN_LABELS,
      defs: PLAN_DEFS,
      liveBilling: isLiveBilling(),
    });
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    }
    throw err;
  }
}
