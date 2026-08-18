/**
 * GET /api/admin/email-probe — ask Resend whether email actually works.
 *
 * Admin-gated and read-only: it lists verified domains, it never sends. Use it
 * to settle "is the key right?" definitively instead of re-entering the value
 * and hoping.
 *
 * WHY THIS EXISTS: RESEND_API_KEY and RESEND_FROM_EMAIL are marked SENSITIVE in
 * Vercel, so `vercel env pull` writes "[SENSITIVE]" rather than the value. The
 * stored credential is therefore unreadable from outside — only the running
 * deployment can see it. Three separate debugging rounds were spent inspecting
 * the value from the wrong side of that boundary. The app has to answer.
 *
 * The response deliberately carries NO key material: a shape description
 * (prefix and length), Resend's own status code, and the verified domain list.
 */

import { NextResponse } from "next/server";
import { probeEmailConfig } from "@/lib/email/send";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  const adminToken = process.env.ADMIN_API_TOKEN;
  const cronSecret = process.env.CRON_SECRET;

  // Same shape as every other admin route: compared against a non-empty
  // configured value only, so an unset env var can never authorise an empty header.
  const ok =
    (!!adminToken && authHeader === `Bearer ${adminToken}`) ||
    (!!cronSecret && authHeader === `Bearer ${cronSecret}`);
  if (!ok) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const probe = await probeEmailConfig();
  // 200 regardless of verdict — the probe SUCCEEDED in reporting a broken
  // config. A non-200 here would make "the probe failed" and "email is broken"
  // look the same, which is the confusion this route exists to end.
  return NextResponse.json(probe);
}
