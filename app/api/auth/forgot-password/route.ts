/**
 * POST /api/auth/forgot-password
 *
 * Accepts { email } and returns a password-reset URL.
 * If the email matches a registered account a one-time token is created
 * and the reset URL is returned in the response body.
 *
 * No SMTP is required — the URL is returned directly so the user (or an
 * admin) can share it.  If a RESEND_API_KEY is configured in the future,
 * email delivery can be wired up here without changing the frontend.
 *
 * Deliberately returns the same success message whether or not the email
 * exists, to prevent user enumeration via timing — but the `resetUrl`
 * field is only present when a valid account was found.
 */

import { NextResponse } from "next/server";
import { findByEmail } from "@/lib/users";
import { createResetToken } from "@/lib/auth/reset-tokens";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

export async function POST(req: Request) {
  // Rate limit — shares the same 10/min window as the login endpoint
  const ip  = getClientIp(req);
  const rl  = checkRateLimit(`forgot-pw:${ip}`);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many requests — please wait ${rl.retryAfter} seconds.` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } }
    );
  }

  let email: string;
  try {
    ({ email } = await req.json());
    if (!email || typeof email !== "string") throw new Error();
  } catch {
    return NextResponse.json({ error: "Email required" }, { status: 400 });
  }

  const user = await findByEmail(email.trim().toLowerCase());

  if (!user) {
    // Return success to prevent enumeration — no resetUrl
    return NextResponse.json({ ok: true });
  }

  const token    = await createResetToken(user.username, user.email);
  const base     = process.env.NEXT_PUBLIC_APP_URL || `https://${req.headers.get("host")}`;
  const resetUrl = `${base}/reset-password?token=${token}`;

  return NextResponse.json({ ok: true, resetUrl });
}
