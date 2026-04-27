import { NextResponse } from "next/server";
import { createSession } from "@/lib/auth";
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

  const { username, password } = await req.json();

  if (!username || !password) {
    return NextResponse.json({ error: "Username and password required" }, { status: 400 });
  }

  const user = await validateCredentials(username, password);
  if (!user) {
    return NextResponse.json({ error: "Wrong username or password" }, { status: 401 });
  }

  // Record last login time (best-effort, non-blocking)
  updateUser(username, { lastLoginAt: new Date().toISOString() }).catch(() => {});

  await createSession(username, user.sessionVersion ?? 1);
  return NextResponse.json({
    success: true,
    username,
    onboardingCompleted: user.onboardingCompleted ?? false,
  });
}

export async function DELETE() {
  const headers = new Headers();
  headers.append("Content-Type", "application/json");
  headers.append(
    "Set-Cookie",
    "execauto_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
  );

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers,
  });
}
