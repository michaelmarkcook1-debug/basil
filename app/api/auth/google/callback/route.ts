import { NextResponse } from "next/server";
import { exchangeCode } from "@/lib/google/auth";

// GET /api/auth/google/callback — handles Google OAuth callback
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");

  if (!code) {
    return NextResponse.redirect(new URL("/dashboard/settings?error=no_code", req.url));
  }

  try {
    await exchangeCode(code);
    return NextResponse.redirect(new URL("/dashboard/settings?connected=google", req.url));
  } catch (e) {
    console.error("Google OAuth error:", e);
    return NextResponse.redirect(new URL("/dashboard/settings?error=oauth_failed", req.url));
  }
}
