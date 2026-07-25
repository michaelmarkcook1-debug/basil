import { NextResponse } from "next/server";
import { createSession, destroySession, getSessionUser } from "@/lib/auth";
import { validateCredentials, updateUser, revokeUserSessions } from "@/lib/users";
import { checkRateLimitDurable, getClientIp } from "@/lib/rate-limit";

export async function POST(req: Request) {
  // Rate limit by IP — 10 attempts per minute, enforced across instances.
  const ip = getClientIp(req);
  const rl = await checkRateLimitDurable(`login:${ip}`);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many login attempts — please wait ${rl.retryAfter} seconds.` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } }
    );
  }

  let username: string, password: string;
  try {
    ({ username, password } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!username || !password) {
    return NextResponse.json({ error: "Username and password required" }, { status: 400 });
  }

  const user = await validateCredentials(username, password);
  if (!user) {
    return NextResponse.json({ error: "Wrong username or password" }, { status: 401 });
  }
  // Reject suspended accounts at the door — don't mint a session cookie or bump
  // lastLoginAt for a disabled user (downstream guards reject them anyway, but a
  // valid-signature JWT + a success response for a suspended account is wrong).
  if (user.disabled) {
    return NextResponse.json({ error: "This account has been disabled." }, { status: 403 });
  }
  // Record last login time (best-effort, non-blocking)
  updateUser(username, { lastLoginAt: new Date().toISOString() }).catch(() => {}); // fire-and-forget
  const sessionVersion = user.sessionVersion ?? 1;

  await createSession(username, sessionVersion);
  return NextResponse.json({
    success: true,
    username,
    onboardingCompleted: true,
  });
}

export async function DELETE() {
  // Revoke server-side so a captured session cookie can't be replayed after
  // logout. Bumping sessionVersion invalidates ALL of the user's JWTs (logout
  // everywhere) — the safe default for a 30-day token.
  const username = await getSessionUser();
  if (username) {
    await revokeUserSessions(username).catch((err) => {
      console.error("[auth/logout] session revoke failed:", err instanceof Error ? err.message : err);
    });
  }
  await destroySession();
  return NextResponse.json({ success: true });
}
