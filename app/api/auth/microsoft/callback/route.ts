import { NextResponse } from "next/server";
import { exchangeCode } from "@/lib/microsoft/auth";
import { getSessionUser } from "@/lib/auth";

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

  // Detect admin-consent-required error from Azure before attempting token exchange.
  const oauthError = searchParams.get("error");
  const oauthErrorDesc = searchParams.get("error_description") ?? "";
  if (oauthError === "access_denied" && oauthErrorDesc.toLowerCase().includes("admin")) {
    console.error("[microsoft-callback] Admin consent required:", oauthErrorDesc);
    return NextResponse.redirect(
      new URL("/dashboard/settings?error=microsoft_admin_consent", req.url)
    );
  }

  const from = req.headers.get("cookie")?.match(/basil_auth_from=([^;]+)/)?.[1] ?? "";
  const successDest = from === "onboarding" ? "/onboarding?connected=microsoft" : "/dashboard/settings?connected=microsoft";
  const errorDest   = from === "onboarding" ? "/onboarding?error=microsoft_auth" : "/dashboard/settings?error=microsoft_auth";

  try {
    const username = (await getSessionUser());
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    await exchangeCode(code, username, origin);
    const res = NextResponse.redirect(new URL(successDest, req.url));
    res.cookies.set("basil_auth_from", "", { path: "/", maxAge: 0 });
    return res;
  } catch (e) {
    console.error("[microsoft-callback] OAuth error:", e instanceof Error ? e.message : e);
    const res = NextResponse.redirect(new URL(errorDest, req.url));
    res.cookies.set("basil_auth_from", "", { path: "/", maxAge: 0 });
    return res;
  }
}
