import { NextResponse } from "next/server";
import { exchangeCode } from "@/lib/microsoft/auth";

// GET /api/auth/microsoft/callback — handles Microsoft OAuth callback
export async function GET(req: Request) {
  const reqUrl = new URL(req.url);
  const { searchParams, origin } = reqUrl;
  const code = searchParams.get("code");

  if (!code) {
    const error = searchParams.get("error_description") ?? searchParams.get("error") ?? "no_code";
    console.error("[microsoft-callback] Missing code, error:", error);
    return NextResponse.redirect(new URL("/dashboard/settings?error=no_code", req.url));
  }

  try {
    // Pass the same origin used when initiating the OAuth flow so the
    // redirect_uri in the token exchange exactly matches the authorization request.
    await exchangeCode(code, origin);
    console.log("[microsoft-callback] OAuth exchange successful");
    return NextResponse.redirect(new URL("/dashboard/settings?connected=microsoft", req.url));
  } catch (e) {
    console.error("[microsoft-callback] OAuth error:", e instanceof Error ? e.message : e);
    return NextResponse.redirect(new URL("/dashboard/settings?error=microsoft_auth", req.url));
  }
}
