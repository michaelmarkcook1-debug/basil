import { NextResponse } from "next/server";
import { exchangeCode } from "@/lib/microsoft/auth";

// GET /api/auth/microsoft/callback — handles Microsoft OAuth callback
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");

  if (!code) {
    return NextResponse.redirect(new URL("/dashboard/settings?error=no_code", req.url));
  }

  try {
    await exchangeCode(code);
    return NextResponse.redirect(new URL("/dashboard/settings?connected=microsoft", req.url));
  } catch (e) {
    console.error("[microsoft-callback] OAuth error:", e instanceof Error ? e.message : e);
    return NextResponse.redirect(new URL("/dashboard/settings?error=microsoft_auth", req.url));
  }
}
