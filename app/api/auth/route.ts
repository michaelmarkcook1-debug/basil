import { NextResponse } from "next/server";
import { SignJWT } from "jose";

const secret = new TextEncoder().encode(
  process.env.AUTH_SECRET || "dev-secret-change-me"
);

export async function POST(req: Request) {
  const { password } = await req.json();
  const expected = process.env.APP_PASSWORD || "execauto2024";

  if (password !== expected) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  const token = await new SignJWT({ authenticated: true })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(secret);

  const headers = new Headers();
  headers.append("Content-Type", "application/json");
  headers.append(
    "Set-Cookie",
    `execauto_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`
  );

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers,
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
