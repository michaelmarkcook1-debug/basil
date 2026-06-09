import { NextResponse } from "next/server";
import { createSession, destroySession } from "@/lib/auth";
import { validateCredentials, updateUser } from "@/lib/users";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

export async function POST(req: Request) {
  // Rate limit by IP — 10 attempts per minute
  const ip = getClientIp(req);
  const rl = checkRateLimit(`login:${ip}`);
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
  await destroySession();
  return NextResponse.json({ success: true });
}
