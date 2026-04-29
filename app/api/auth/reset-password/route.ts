/**
 * POST /api/auth/reset-password
 * Body: { token, newPassword }
 *
 * Validates the one-time reset token, changes the password, and
 * invalidates all existing sessions (by bumping sessionVersion).
 */

import { NextResponse } from "next/server";
import { changePassword } from "@/lib/users";
import { validateResetToken, consumeResetToken } from "@/lib/auth/reset-tokens";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

export async function POST(req: Request) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`reset-pw:${ip}`);
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

  const username = await validateResetToken(token);
  if (!username) {
    return NextResponse.json(
      { error: "This reset link has expired or already been used. Please request a new one." },
      { status: 400 }
    );
  }

  try {
    await changePassword(username, newPassword);
    await consumeResetToken(token);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[reset-password] Failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Failed to update password. Please try again." }, { status: 500 });
  }
}
