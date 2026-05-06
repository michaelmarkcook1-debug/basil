import { NextResponse } from "next/server";
import { exchangeCode } from "@/lib/microsoft/auth";
import { getSessionUser } from "@/lib/auth";
import { forceFlushSnapshot } from "@/lib/storage/persistent";

// GET /api/auth/microsoft/callback — handles Microsoft OAuth callback
export async function GET(req: Request) {
  const { searchParams, origin } = new URL(req.url);

  const from       = req.headers.get("cookie")?.match(/basil_auth_from=([^;]+)/)?.[1] ?? "";
  const successDest = from === "onboarding" ? "/onboarding?connected=microsoft" : "/dashboard/settings?connected=microsoft";
  const errorDest   = from === "onboarding" ? "/onboarding?error=microsoft_auth"  : "/dashboard/settings?error=microsoft_auth";

  // Helper to redirect and clear the from-cookie on every exit path
  const redirect = (dest: string) => {
    const res = NextResponse.redirect(new URL(dest, req.url));
    res.cookies.set("basil_auth_from", "", { path: "/", maxAge: 0 });
    return res;
  };

  // ── OAuth error check (must run BEFORE the !code guard) ───────────────────
  // When Azure returns an error (access_denied, admin_consent_required, etc.)
  // the `code` parameter is absent — checking !code first would swallow the
  // specific error and show a generic "no_code" message instead.
  const oauthError     = searchParams.get("error");
  const oauthErrorDesc = searchParams.get("error_description") ?? "";

  if (oauthError) {
    if (oauthError === "access_denied" && oauthErrorDesc.toLowerCase().includes("admin")) {
      console.error("[microsoft/callback] Admin consent required:", oauthErrorDesc.slice(0, 200));
      return redirect("/dashboard/settings?error=microsoft_admin_consent");
    }
    console.error("[microsoft/callback] OAuth provider error:", oauthError, oauthErrorDesc.slice(0, 200));
    return redirect(errorDest);
  }

  // ── Missing code ──────────────────────────────────────────────────────────
  const code = searchParams.get("code");
  if (!code) {
    console.warn("[microsoft/callback] Missing OAuth code — aborting flow.");
    return redirect(errorDest);
  }

  // ── Session guard ─────────────────────────────────────────────────────────
  // Must verify the user is logged in BEFORE exchanging the code.
  // Redirect (not JSON 401) because this is a browser redirect flow.
  let username: string | null;
  try {
    username = await getSessionUser();
  } catch (sessionErr) {
    console.error("[microsoft/callback] Session validation error:", sessionErr instanceof Error ? sessionErr.message : sessionErr);
    return redirect(errorDest);
  }

  if (!username) {
    console.warn("[microsoft/callback] No authenticated session — cannot save tokens. User must log in first.");
    return redirect("/login?from=microsoft_callback");
  }

  // ── Token exchange ────────────────────────────────────────────────────────
  try {
    await exchangeCode(code, username, origin);
    await forceFlushSnapshot();
    console.log(`[microsoft/callback] Tokens saved for user ${username}. Redirecting to ${successDest}`);
    return redirect(successDest);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Never log the code value — it is single-use and sensitive
    console.error(`[microsoft/callback] Token exchange or save failed for user ${username}:`, msg);
    return redirect(errorDest);
  }
}
