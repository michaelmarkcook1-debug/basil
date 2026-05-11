import { NextResponse } from "next/server";
import { createSession } from "@/lib/auth";

/**
 * GET /api/auth/dev-login
 *
 * Dev-only auto-login. Creates a real session cookie for the admin user and
 * redirects to /dashboard. Only works when SKIP_AUTH=true in .env.local and
 * NODE_ENV is not production.
 */
export async function GET(req: Request) {
  const skipAuth = process.env.SKIP_AUTH === "true";

  if (!skipAuth) {
    return NextResponse.json({ error: "Not available" }, { status: 404 });
  }

  const username = process.env.SKIP_AUTH_USER || process.env.ADMIN_USERNAME;
  if (!username) {
    return NextResponse.json(
      { error: "Set SKIP_AUTH_USER or ADMIN_USERNAME before using dev-login." },
      { status: 500 }
    );
  }
  await createSession(username, 1);

  return NextResponse.redirect(new URL("/dashboard", req.url));
}
