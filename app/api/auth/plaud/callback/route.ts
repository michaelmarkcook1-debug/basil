/** GET /api/auth/plaud/callback — Plaud sends the user back here after they approve Basil. */
import { NextResponse, after } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { verifyOAuthState, clearOAuthStateCookie } from "@/lib/auth/oauth-state";
import { exchangePlaudCode } from "@/lib/plaud/oauth";
import { syncPlaud } from "@/lib/plaud/sync";

export const maxDuration = 300;

function done(req: Request, path: string) {
  const res = NextResponse.redirect(new URL(path, req.url));
  const cleared = clearOAuthStateCookie("plaud");
  res.cookies.set(cleared.name, cleared.value, cleared.options);
  res.cookies.set("basil_plaud_pkce", "", { path: "/", maxAge: 0 });
  return res;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const err = url.searchParams.get("error");
  if (err) {
    console.warn(`[plaud/callback] Plaud returned ${err}: ${url.searchParams.get("error_description") ?? ""}`);
    return done(req, `/dashboard/settings?error=plaud_oauth_failed&plaud_error=${encodeURIComponent(err)}`);
  }
  const code = url.searchParams.get("code");
  if (!code) return done(req, "/dashboard/settings?error=no_code");
  if (!verifyOAuthState("plaud", req, url.searchParams.get("state"))) {
    console.warn("[plaud/callback] state mismatch — possible CSRF, aborting.");
    return done(req, "/dashboard/settings?error=plaud_oauth_failed");
  }
  const username = await getSessionUser();
  if (!username) return done(req, "/login?error=session_expired");
  const verifier = req.headers.get("cookie")?.match(/basil_plaud_pkce=([^;]+)/)?.[1];
  if (!verifier) return done(req, "/dashboard/settings?error=plaud_oauth_failed");
  try {
    await exchangePlaudCode(username, code, decodeURIComponent(verifier));
    console.log(`[plaud/callback] Plaud connected for ${username}`);
    after(() => syncPlaud(username).then(() => undefined, (e) =>
      console.warn(`[plaud/callback] first sync failed for ${username}:`, e instanceof Error ? e.message : e)));
    return done(req, "/dashboard/settings?connected=plaud");
  } catch (e) {
    console.error("[plaud/callback] token exchange failed:", e instanceof Error ? e.message : e);
    return done(req, "/dashboard/settings?error=plaud_oauth_failed");
  }
}
