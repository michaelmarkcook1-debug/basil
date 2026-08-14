import { NextResponse } from "next/server";
import { findByEmail, findByUsername } from "@/lib/users";
import { createResetToken } from "@/lib/auth/reset-tokens";
import { forceFlushSnapshot } from "@/lib/storage/persistent";

/**
 * POST /api/admin/reset-link — break-glass password recovery.
 *
 * WHY THIS EXISTS
 * Password reset is delivered by email, and email needs RESEND_API_KEY. That
 * key is not configured, so `sendResetEmail` returns false and the link is
 * never delivered. In production the code deliberately does NOT log the link
 * (Vercel runtime logs are readable by anyone with project access, so a logged
 * link is an account-takeover vector). The result, found 2026-08-03: a
 * locked-out operator has NO recovery path at all. EMERGENCY_LOGIN_TOKEN is
 * set in the environment but referenced nowhere in the code — dead config that
 * looks like a safety net and is not one.
 *
 * WHY RETURNING THE URL IS SAFE HERE, WHEN IT WAS REMOVED FROM forgot-password
 * The unauthenticated endpoint must never return a reset URL — that is an
 * account takeover for anyone who can name a user. This route is different in
 * one decisive way: it requires the ADMIN bearer secret, which is the same
 * credential that already authorises cron ingest and the admin diagnostics. A
 * caller holding it can already read and write every user's data directly, so
 * handing them a reset link grants nothing they did not have. The
 * unauthenticated path keeps its guarantee untouched.
 *
 * The operator opens the returned URL and sets their own password; the password
 * itself never passes through this endpoint, and nobody assisting them needs to
 * see or choose it.
 *
 * This is a stopgap for the real fix — configure RESEND_API_KEY so ordinary
 * users can recover unaided. Delete it once email delivery works, or keep it as
 * the deliberate break-glass and say so in the runbook.
 */
export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization");
  const adminToken = process.env.ADMIN_API_TOKEN;
  const cronSecret = process.env.CRON_SECRET;

  // Accept either admin credential. Compared against a non-empty configured
  // value only, so an unset env var can never authorise an empty header.
  const ok =
    (!!adminToken && authHeader === `Bearer ${adminToken}`) ||
    (!!cronSecret && authHeader === `Bearer ${cronSecret}`);

  if (!ok) {
    // Same shape and status as any other unauthorised admin call — this route's
    // existence must not become a probe for whether a username is real.
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let identifier: string;
  try {
    const body = await req.json();
    identifier =
      typeof body.username === "string"
        ? body.username.trim().toLowerCase()
        : typeof body.email === "string"
          ? body.email.trim().toLowerCase()
          : "";
    if (!identifier) throw new Error("missing");
  } catch {
    return NextResponse.json({ error: "username or email required" }, { status: 400 });
  }

  // Same lookup order as forgot-password, including the local-part fallback for
  // the common "typed my email, my username is the bit before the @" case.
  let user = identifier.includes("@") ? await findByEmail(identifier) : null;
  if (!user) user = await findByUsername(identifier);
  if (!user && identifier.includes("@")) user = await findByUsername(identifier.split("@")[0]);

  if (!user) {
    // The caller is already authenticated as an admin, so naming a missing user
    // plainly is correct here — enumeration protection guards the PUBLIC route,
    // and a vague answer would just make a real recovery harder to debug.
    return NextResponse.json({ error: `No such user: ${identifier}` }, { status: 404 });
  }

  let token: string;
  try {
    token = await createResetToken(user.username, user.email);
    await forceFlushSnapshot();
  } catch (err) {
    console.error("[admin/reset-link] createResetToken failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not generate a reset token." }, { status: 500 });
  }

  const base = process.env.NEXT_PUBLIC_APP_URL || `https://${req.headers.get("host")}`;

  // Logged WITHOUT the token: an admin used the break-glass, which is worth an
  // audit trail, but the link itself must never reach the runtime logs.
  console.warn(
    `[admin/reset-link] break-glass reset link issued for "${user.username}" — ` +
    `configure RESEND_API_KEY so users can recover without this.`
  );

  return NextResponse.json({
    resetUrl: `${base}/reset-password?token=${token}`,
    username: user.username,
    expiresInMinutes: 60,
    note: "Open this once and set a new password. It expires in an hour and can only be used once.",
  });
}
