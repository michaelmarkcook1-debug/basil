import { NextResponse, after } from "next/server";
import { exchangeCode } from "@/lib/google/auth";
import { getSessionUser } from "@/lib/auth";
import { forceFlushSnapshot } from "@/lib/storage/persistent";
import { autoRegisterGoogleWebhooks } from "@/lib/google/register-webhooks";
import { triggerOnboardingBackfill } from "@/lib/onboarding/backfill";
import { verifyOAuthState, clearOAuthStateCookie } from "@/lib/auth/oauth-state";

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

  // Helper to produce a clean redirect and clear the transient cookies regardless of outcome
  const redirect = (dest: string) => {
    const res = NextResponse.redirect(new URL(dest, req.url));
    res.cookies.set("basil_auth_from", "", { path: "/", maxAge: 0 });
    const cleared = clearOAuthStateCookie("google");
    res.cookies.set(cleared.name, cleared.value, cleared.options);
    return res;
  };

  // ── CSRF state guard ───────────────────────────────────────────────────────
  // The state echoed back must match the cookie set at initiation; otherwise
  // this callback wasn't started by this browser (login-CSRF account linking).
  if (!verifyOAuthState("google", req, searchParams.get("state"))) {
    console.warn("[google/callback] OAuth state mismatch — possible CSRF, aborting.");
    return redirect(errorDest);
  }

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

    // ── Auto-register push webhooks ──────────────────────────────────────────
    // Fire-and-forget — do not block the redirect. Errors are logged but never
    // surface to the user. If env vars aren't configured (e.g. GMAIL_PUBSUB_TOPIC
    // missing), the call is a silent no-op.
    autoRegisterGoogleWebhooks(username).then(({ gmail, calendar }) => {
      console.log(`[google/callback] Webhook auto-registration: gmail=${gmail} calendar=${calendar}`);
    }).catch((err) => {
      console.error("[google/callback] Webhook auto-registration threw:", err instanceof Error ? err.message : err);
    });

    // ── Day-0 backfill ────────────────────────────────────────────────────────
    // Pull recent signal + generate the first briefing now, so the dashboard
    // fills in within a minute instead of waiting for tomorrow's cron. after()
    // runs this once the redirect has been sent — it never blocks the user.
    const backfillUser = username;
    after(() => triggerOnboardingBackfill(backfillUser));

    return redirect(successDest);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Never log the code value — it may be usable for one exchange
    console.error(`[google/callback] Token exchange or save failed for user ${username}:`, msg);
    return redirect(errorDest);
  }
}
