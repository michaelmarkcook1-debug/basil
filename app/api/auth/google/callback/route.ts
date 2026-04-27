import { NextResponse } from "next/server";
import { exchangeCode } from "@/lib/google/auth";
import { getSessionUser } from "@/lib/auth";

// GET /api/auth/google/callback — handles Google OAuth callback
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");

  if (!code) {
    return NextResponse.redirect(new URL("/dashboard/settings?error=no_code", req.url));
  }

  const from = req.headers.get("cookie")?.match(/basil_auth_from=([^;]+)/)?.[1] ?? "";
  const successDest = from === "onboarding" ? "/onboarding?connected=google" : "/dashboard/settings?connected=google";
  const errorDest   = from === "onboarding" ? "/onboarding?error=google_auth" : "/dashboard/settings?error=oauth_failed";

  try {
    const username = (await getSessionUser());
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    await exchangeCode(code, username);
    const res = NextResponse.redirect(new URL(successDest, req.url));
    res.cookies.set("basil_auth_from", "", { path: "/", maxAge: 0 });
    return res;
  } catch (e) {
    console.error("Google OAuth error:", e);
    const res = NextResponse.redirect(new URL(errorDest, req.url));
    res.cookies.set("basil_auth_from", "", { path: "/", maxAge: 0 });
    return res;
  }
}
