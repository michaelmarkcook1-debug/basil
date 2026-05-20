import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { findByUsername } from "@/lib/users";

const rawSecret = process.env.AUTH_SECRET;
if (!rawSecret && process.env.NODE_ENV === "production") {
  // Throw at module-load time so the first request to any auth-protected route
  // fails with a clear 500 rather than silently signing tokens with the dev
  // fallback (which is public knowledge and would compromise all sessions).
  throw new Error(
    "AUTH_SECRET environment variable is required in production. " +
    "Set it in Vercel: Settings → Environment Variables → AUTH_SECRET."
  );
}
const secret = new TextEncoder().encode(rawSecret || "dev-secret-change-me");

const COOKIE_NAME = "execauto_session";

/**
 * Create a new session JWT.
 * Embeds the user's current sessionVersion so we can invalidate it later
 * (on password change or admin revocation) by bumping the stored version.
 */
export async function createSession(username: string, sessionVersion = 1) {
  const token = await new SignJWT({ authenticated: true, username, sv: sessionVersion })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(secret);

  (await cookies()).set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 30, // 30 days
    path: "/",
  });
}

// ── Dev bypass ───────────────────────────────────────────────────────────────
// Set SKIP_AUTH=true in .env.local to bypass login (local dev only).
// Explicitly blocked in production so an accidental env var deploy can't open
// all routes to unauthenticated access.
if (process.env.SKIP_AUTH === "true" && process.env.NODE_ENV === "production") {
  throw new Error(
    "SKIP_AUTH=true is not permitted in production. " +
    "Remove it from Vercel environment variables immediately."
  );
}
export const SKIP_AUTH = process.env.SKIP_AUTH === "true";
const SKIP_AUTH_USER = process.env.SKIP_AUTH_USER || process.env.ADMIN_USERNAME;

/**
 * Verify the current session.
 * Checks JWT signature, expiry, and that the user is not disabled and
 * the sessionVersion in the token matches the one stored for the user.
 * Returns true only if all checks pass.
 */
export async function verifySession(): Promise<boolean> {
  if (SKIP_AUTH) return true;
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) return false;

  try {
    const { payload } = await jwtVerify(token, secret);
    const username = payload.username as string | undefined;
    if (!username) return false;

    // Check account is not disabled and session version is current
    const user = await findByUsername(username);
    if (!user) return false;
    if (user.disabled) return false;

    const tokenSv = (payload.sv as number | undefined) ?? 1;
    const userSv = user.sessionVersion ?? 1;
    if (tokenSv !== userSv) return false;

    return true;
  } catch {
    return false;
  }
}

/**
 * Return the username from the current session, or null.
 * Same validation as verifySession.
 */
export async function getSessionUser(): Promise<string | null> {
  if (SKIP_AUTH) return SKIP_AUTH_USER || null;
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, secret);
    const username = payload.username as string | undefined;
    if (!username) return null;

    const user = await findByUsername(username);
    if (!user || user.disabled) return null;

    const tokenSv = (payload.sv as number | undefined) ?? 1;
    const userSv = user.sessionVersion ?? 1;
    if (tokenSv !== userSv) return null;

    return username;
  } catch {
    return null;
  }
}

export async function destroySession() {
  (await cookies()).delete(COOKIE_NAME);
}
