import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getUsers, isAdminUser } from "@/lib/users";
import { getSpendSummary } from "@/lib/ai/spend-guard";

/**
 * GET /api/admin/ai-spend
 *
 * Month-to-date AI spend visibility for admins:
 *   – global USD spent this period vs the configured ceiling
 *   – per-user breakdown (only users with non-zero spend)
 *   – whether an ATOMIC durable counter (Upstash Redis) is active or we're on
 *     the approximate Blob fallback (`durable: false` → caps are soft)
 *   – whether the AI_SPEND_HARD_STOP kill switch is engaged
 *
 *   200 — summary returned
 *   401 — unauthenticated
 *   403 — not an admin
 */
export async function GET(req: Request) {
  // CRON_SECRET bearer is accepted alongside the admin session so the ceiling
  // can be verified from outside a browser. Vercel returns sensitive env vars
  // as "[SENSITIVE]", so the ONLY way to confirm a cap is really set to the
  // intended number is to ask the running deployment what it reads.
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  const isCronCall = !!cronSecret && authHeader === `Bearer ${cronSecret}`;

  if (!isCronCall) {
    const username = await getSessionUser();
    if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    if (!isAdminUser(username)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const users = await getUsers();
  const summary = await getSpendSummary(users.map((u) => u.username));

  return NextResponse.json(summary);
}
