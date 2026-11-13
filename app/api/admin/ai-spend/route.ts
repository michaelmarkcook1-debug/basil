import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getUsers, isAdminUser } from "@/lib/users";
import { getSpendSummary, resetUserSpendToday } from "@/lib/ai/spend-guard";

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

/**
 * POST /api/admin/ai-spend  { action: "reset-today", username }
 *
 * Gives one user their full daily AI limit back for the rest of today (UTC).
 * Admin session only. The spend log is untouched, so nothing is lost from
 * the monthly totals.
 */
export async function POST(req: Request) {
  const admin = await getSessionUser();
  if (!admin) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  if (!isAdminUser(admin)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({})) as { action?: unknown; username?: unknown };
  if (body.action !== "reset-today" || typeof body.username !== "string") {
    return NextResponse.json({ error: 'Send { action: "reset-today", username }.' }, { status: 400 });
  }
  const wanted = body.username.toLowerCase();
  const target = (await getUsers()).find((u) => u.username.toLowerCase() === wanted);
  if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const out = await resetUserSpendToday(target.username);
  console.info(`[admin/ai-spend] ${admin} reset ${target.username}'s AI spend for ${out.day} (was $${out.clearedUsd.toFixed(2)})`);
  return NextResponse.json({ ok: true, username: target.username, ...out });
}
