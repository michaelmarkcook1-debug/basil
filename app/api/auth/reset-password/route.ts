/**
 * POST /api/auth/reset-password
 * Body: { token, newPassword }
 *
 * Validates the one-time reset token, changes the password, and
 * invalidates all existing sessions (by bumping sessionVersion).
 */

import { NextResponse } from "next/server";
import { changePassword } from "@/lib/users";
import { claimResetToken, releaseResetToken } from "@/lib/auth/reset-tokens";
import { checkRateLimitDurable, getClientIp } from "@/lib/rate-limit";
import { forceFlushSnapshot } from "@/lib/storage/persistent";

export async function POST(req: Request) {
  const ip = getClientIp(req);
  const rl = await checkRateLimitDurable(`reset-pw:${ip}`);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } }
    );
  }

  let token: string, newPassword: string;
  try {
    ({ token, newPassword } = await req.json());
    if (!token || !newPassword) throw new Error();
  } catch {
    return NextResponse.json({ error: "Token and new password required" }, { status: 400 });
  }

  if (newPassword.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
  }

  // Claim the token BEFORE touching the password. One durable transition,
  // under the lock, on a fresh read — a second request, or a second warm
  // instance with a stale cache, finds it already used and stops here.
  const username = await claimResetToken(token);
  if (!username) {
    return NextResponse.json(
      { error: "This reset link has expired or already been used. Please request a new one." },
      { status: 400 }
    );
  }

  try {
    await changePassword(username, newPassword);
    await forceFlushSnapshot(); // persist updated sessionVersion so new password survives cold start
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[reset-password] Failed:", e instanceof Error ? e.message : e); // ci-ok: route prefix only — not logging a password value
    // The claim succeeded but the password write did not. Hand the token back
    // so the link the user is holding still works — expiry still bounds it.
    await releaseResetToken(token).catch((err) =>
      console.error("[reset-password] could not release claimed token:", err instanceof Error ? err.message : err) // ci-ok: error message only — never the token value
    );
    return NextResponse.json({ error: "Failed to update password. Please try again." }, { status: 500 });
  }
}
