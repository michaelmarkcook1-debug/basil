/**
 * POST /api/admin/linkedin-backfill — harvest LinkedIn profiles from signatures
 * in mail already received.
 *
 * Admin-gated because it reads message bodies. It writes only the `linkedin`
 * field on contacts that already exist, never creates or overwrites, and makes
 * no AI call — so it is unaffected by the daily spend cap and safe to re-run.
 *
 * Body (all optional): { username?, maxMessages?, maxAgeDays? }
 * `username` defaults to the caller's session; a CRON_SECRET caller must name
 * one, since a bearer token has no session to infer from.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { backfillLinkedIn } from "@/lib/contacts/backfill-linkedin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization");
  const adminToken = process.env.ADMIN_API_TOKEN;
  const cronSecret = process.env.CRON_SECRET;

  // Compared against a non-empty configured value only, so an unset env var can
  // never authorise an empty header.
  const bearerOk =
    (!!adminToken && authHeader === `Bearer ${adminToken}`) ||
    (!!cronSecret && authHeader === `Bearer ${cronSecret}`);

  const session = await getSessionUser();
  if (!bearerOk && !session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: { username?: string; maxMessages?: number; maxAgeDays?: number } = {};
  try { body = await req.json(); } catch { /* all fields optional */ }

  const username = body.username ?? session;
  if (!username) {
    return NextResponse.json(
      { error: "username required when calling with a bearer token" },
      { status: 400 },
    );
  }

  try {
    const result = await backfillLinkedIn(username, {
      maxMessages: body.maxMessages,
      maxAgeDays: body.maxAgeDays,
    });
    return NextResponse.json({ ok: true, username, ...result });
  } catch (e) {
    // Gmail not connected, token expired, quota — all end here. Reported as a
    // failure rather than an empty result, because "found nothing" and "could
    // not look" must never be the same response.
    const message = e instanceof Error ? e.message : String(e);
    console.error("[linkedin-backfill] failed:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
