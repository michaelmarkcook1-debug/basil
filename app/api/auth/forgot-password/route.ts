/**
 * POST /api/auth/forgot-password
 *
 * Accepts { email } or { username } and issues a password-reset link.
 *
 * Delivery:
 *  - Resend email when RESEND_API_KEY is set and the user has an email address.
 *  - The reset URL is NEVER returned in the HTTP response — that would let
 *    anyone who knows a target's email reset their password (account takeover).
 *  - For no-email / self-hosted setups, the URL is logged server-side so an
 *    operator can retrieve it from the logs; it never crosses the network to
 *    the caller.
 *
 * Security:
 *  - Same success shape regardless of whether the account exists (prevents enumeration)
 *  - Reset URL never present in the response body
 *  - Rate-limited: 10 req/min per IP
 */

import { NextResponse } from "next/server";
import { sendEmail, isEmailConfigured, resendKeyProblem } from "@/lib/email/send";
import { findByEmail, findByUsername } from "@/lib/users";
import { createResetToken } from "@/lib/auth/reset-tokens";
import { checkRateLimitDurable, getClientIp } from "@/lib/rate-limit";
import { forceFlushSnapshot } from "@/lib/storage/persistent";

// ── Email sending via Resend ──────────────────────────────────────────────────

async function sendResetEmail(to: string, name: string, resetUrl: string): Promise<boolean> {
  // Delegates to the single Resend client. This route used to hand-roll its own
  // fetch, so the key handling here and in lib/email/send.ts drifted apart —
  // trimming and shape validation landed in one and not the other.
  const { ok, error } = await sendEmail({
    to,
    subject: "Reset your Basil password",
    html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;">
            <h2 style="font-size:20px;margin-bottom:8px;">Reset your password</h2>
            <p style="color:#555;margin-bottom:24px;">
              Hi ${name || "there"},<br><br>
              Click the button below to set a new password.
            </p>
            <a href="${resetUrl}" style="display:inline-block;background:#35346B;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;">Set a new password</a>
            <p style="color:#888;font-size:13px;margin-top:24px;">
              This link expires in 1 hour. If you didn't request it, ignore this email.
            </p>
          </div>
        `,
    text: `Reset your Basil password\n\nClick this link (expires in 1 hour):\n${resetUrl}\n\nIf you didn't request this, ignore this email.`,
  });
  if (!ok) console.error("[forgot-password] reset email not sent:", error);
  return ok;
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const ip = getClientIp(req);
  const rl = await checkRateLimitDurable(`forgot-pw:${ip}`);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many requests — please wait ${rl.retryAfter} seconds.` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } }
    );
  }

  let email: string | undefined;
  let username: string | undefined;
  try {
    const body = await req.json();
    email    = typeof body.email    === "string" ? body.email.trim().toLowerCase()    : undefined;
    username = typeof body.username === "string" ? body.username.trim().toLowerCase() : undefined;
    if (!email && !username) throw new Error("missing fields");
  } catch {
    return NextResponse.json({ error: "Email or username required" }, { status: 400 });
  }

  // Look up user — try email first, then username, then treat email field as username
  let user = email ? await findByEmail(email) : null;
  if (!user && username) user = await findByUsername(username);
  if (!user && email)    user = await findByUsername(email.split("@")[0]); // common mistake

  if (!user) {
    // Deliberate same-shape response to prevent account enumeration
    return NextResponse.json({ ok: true, emailSent: false });
  }

  let token: string;
  try {
    token = await createResetToken(user.username, user.email);
    await forceFlushSnapshot();
  } catch (err) {
    console.error("[forgot-password] createResetToken failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not generate reset link. Please try again." }, { status: 500 });
  }

  const base     = process.env.NEXT_PUBLIC_APP_URL || `https://${req.headers.get("host")}`;
  const resetUrl = `${base}/reset-password?token=${token}`;

  const emailSent = user.email ? await sendResetEmail(user.email, user.name, resetUrl) : false;

  // SECURITY: never return resetUrl to the caller — that is an unauthenticated
  // account-takeover. When email delivery didn't happen (no Resend key or the
  // account has no email), log the link server-side so a self-hosted operator
  // can still complete the reset from their own logs.
  if (!emailSent) {
    // SECURITY: never log the full reset URL in production — Vercel runtime logs
    // are readable by anyone with project access, so a logged link is an
    // account-takeover vector. Surface it only in local/dev for operator
    // convenience; in production, flag the misconfiguration without the secret.
    if (process.env.NODE_ENV !== "production") {
      console.info(`[forgot-password] reset link (dev only, email not sent): ${resetUrl}`);
    } else {
      // Distinguish "not configured" from "configured but rejected". The old copy
      // said "set RESEND_API_KEY" in BOTH cases, which sent the operator to
      // re-enter a key that was already there — the actual failure was a 401
      // logged one line above and contradicted by this one.
      console.warn(
        isEmailConfigured()
          ? "[forgot-password] RESEND_API_KEY is configured but the send FAILED — see the error above. " +
            "GET /api/admin/email-probe for the verdict; do not just re-enter the key."
          : `[forgot-password] email not configured: ${resendKeyProblem()}`
      );
    }
  }

  return NextResponse.json({ ok: true, emailSent });
}
