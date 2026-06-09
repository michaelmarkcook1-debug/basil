import { NextResponse } from "next/server";
import { getUsers } from "@/lib/users";
import { getEntitlement, cancelPlan } from "@/lib/billing/entitlement-store";

export const dynamic = "force-dynamic";

/**
 * GET /api/cron/billing-dunning
 *
 * Dunning state machine: a subscription that has been `past_due` longer than
 * the grace window is downgraded to Free. Runs daily.
 *
 *   active → (payment.failed webhook) → past_due → (grace elapsed) → canceled/Free
 *
 * Scaffold: the real provider's Smart Retries will usually resolve past_due
 * before the grace window; this is the backstop that protects revenue/entitlement
 * integrity if retries are exhausted. No-op until real subscriptions exist.
 */

const GRACE_DAYS = 7;

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const users = await getUsers();
  const graceMs = GRACE_DAYS * 24 * 60 * 60 * 1000;
  let downgraded = 0;
  const actions: { username: string; action: string }[] = [];

  for (const user of users) {
    try {
      const ent = await getEntitlement(user.username);
      if (ent.status !== "past_due") continue;
      const age = Date.now() - Date.parse(ent.updatedAt);
      if (Number.isFinite(age) && age >= graceMs) {
        await cancelPlan(user.username);
        downgraded++;
        actions.push({ username: user.username, action: "downgraded-to-free" });
        console.info(`[cron/billing-dunning] grace elapsed for ${user.username} — downgraded to Free`);
      }
    } catch (err) {
      console.error(`[cron/billing-dunning] ${user.username} failed:`, err instanceof Error ? err.message : err);
    }
  }

  return NextResponse.json({ ok: true, scanned: users.length, downgraded, actions, triggeredAt: new Date().toISOString() });
}
