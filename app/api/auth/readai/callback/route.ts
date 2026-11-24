/** GET /api/auth/readai/callback — Read AI sends the user back here after they approve Basil. */
import { NextResponse, after } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { verifyOAuthState, clearOAuthStateCookie } from "@/lib/auth/oauth-state";
import { exchangeReadAiCode } from "@/lib/readai/oauth";
import { syncReadAi } from "@/lib/readai/sync";

export const maxDuration = 300;

function done(req: Request, path: string) {
  const res = NextResponse.redirect(new URL(path, req.url));
  const cleared = clearOAuthStateCookie("readai");
  res.cookies.set(cleared.name, cleared.value, cleared.options);
  res.cookies.set("basil_readai_pkce", "", { path: "/", maxAge: 0 });
  return res;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const err = url.searchParams.get("error");
  if (err) {
    console.warn(`[readai/callback] Read AI returned ${err}: ${url.searchParams.get("error_description") ?? ""}`);
    return done(req, `/dashboard/settings?error=readai_oauth_failed&readai_error=${encodeURIComponent(err)}`);
  }
  const code = url.searchParams.get("code");
  if (!code) return done(req, "/dashboard/settings?error=no_code");
  if (!verifyOAuthState("readai", req, url.searchParams.get("state"))) {
    console.warn("[readai/callback] state mismatch — possible CSRF, aborting.");
    return done(req, "/dashboard/settings?error=readai_oauth_failed");
  }
  const username = await getSessionUser();
  if (!username) return done(req, "/login?error=session_expired");
  const verifier = req.headers.get("cookie")?.match(/basil_readai_pkce=([^;]+)/)?.[1];
  if (!verifier) return done(req, "/dashboard/settings?error=readai_oauth_failed");
  try {
    await exchangeReadAiCode(username, code, decodeURIComponent(verifier));
    console.log(`[readai/callback] Read AI connected for ${username}`);
    after(() => syncReadAi(username).then(() => undefined, (e) =>
      console.warn(`[readai/callback] first sync failed for ${username}:`, e instanceof Error ? e.message : e)));
    return done(req, "/dashboard/settings?connected=readai");
  } catch (e) {
    console.error("[readai/callback] token exchange failed:", e instanceof Error ? e.message : e);
    return done(req, "/dashboard/settings?error=readai_oauth_failed");
  }
}
