import { NextResponse } from "next/server";
import { exchangeCode } from "@/lib/google/auth";
import { getSessionUser } from "@/lib/auth";
import { forceFlushSnapshot } from "@/lib/storage/persistent";

// GET /api/auth/google/callback — handles Google OAuth callback
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");

  if (!code) {
    console.warn("[google/callback] Missing OAuth code — aborting flow.");
    return NextResponse.redirect(new URL("/dashboard/settings?error=no_code", req.url));
  }

  const from = req.headers.get("cookie")?.match(/basil_auth_from=([^;]+)/)?.[1] ?? "";
  const successDest = from === "onboarding" ? "/onboarding?connected=google" : "/dashboard/settings?connected=google";
  const errorDest   = from === "onboarding" ? "/onboarding?error=google_auth" : "/dashboard/settings?error=oauth_failed";

  // Helper to produce a clean redirect and clear the from-cookie regardless of outcome
  const redirect = (dest: string) => {
    const res = NextResponse.redirect(new URL(dest, req.url));
    res.cookies.set("basil_auth_from", "", { path: "/", maxAge: 0 });
    return res;
  };

  // ── Session guard ──────────────────────────────────────────────────────────
  // Must verify the user is logged in BEFORE exchanging the OAuth code.
  // If the session is missing or expired, redirect to the error destination so
  // the user sees the settings page (not a raw JSON 401 in the browser).
  let username: string | null;
  try {
    username = await getSessionUser();
  } catch (sessionErr) {
    console.error("[google/callback] Session validation error:", sessionErr instanceof Error ? sessionErr.message : sessionErr);
    return redirect(errorDest);
  }

  if (!username) {
    console.warn("[google/callback] No authenticated session — cannot save tokens. User must log in first.");
    return redirect("/login?from=google_callback");
  }

  // ── Token exchange ─────────────────────────────────────────────────────────
  try {
    await exchangeCode(code, username);
    // Force-flush so tokens survive a cold start on the very next request.
    await forceFlushSnapshot();
    console.log(`[google/callback] Tokens saved for user ${username}. Redirecting to ${successDest}`);
    return redirect(successDest);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Never log the code value — it may be usable for one exchange
    console.error(`[google/callback] Token exchange or save failed for user ${username}:`, msg);
    return redirect(errorDest);
  }
}
