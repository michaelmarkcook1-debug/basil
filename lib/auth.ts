import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { findByUsername } from "@/lib/users";

const secret = new TextEncoder().encode(
  process.env.AUTH_SECRET || "dev-secret-change-me"
);

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

/**
 * Verify the current session.
 * Checks JWT signature, expiry, and that the user is not disabled and
 * the sessionVersion in the token matches the one stored for the user.
 * Returns true only if all checks pass.
 */
export async function verifySession(): Promise<boolean> {
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
