import { NextResponse } from "next/server";
import { getAuthUrl } from "@/lib/google/auth";
import { getSessionUser, getSessionUserLite } from "@/lib/auth";
import { deleteIntegrationToken } from "@/lib/storage/secure-token-store";
import { forceFlushSnapshot } from "@/lib/storage/persistent";
import { buildOAuthState } from "@/lib/auth/oauth-state";

// GET /api/auth/google — redirects to Google OAuth consent screen
export async function GET(req: Request) {
  // Require an active session before starting the OAuth flow.
  // Use the lite check (JWT-only) so this works even when the encrypted user
  // store is unavailable (e.g. BASIL_TOKEN_ENCRYPTION_KEY not set in this env).
  const username = await getSessionUserLite();
  if (!username) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("return", "/onboarding");
    console.warn("[google/connect] Unauthenticated connect attempt — redirecting to login.");
    return NextResponse.redirect(loginUrl);
  }

  const from = new URL(req.url).searchParams.get("from") ?? "";
  // CSRF state — echoed back on the callback and checked against the cookie.
  const st = buildOAuthState("google");
  const url = `${getAuthUrl()}&state=${encodeURIComponent(st.state)}`;
  console.log(`[google/connect] Starting OAuth flow for user ${username}.`);
  const res = NextResponse.redirect(url);
  res.cookies.set(st.name, st.value, st.options);
  if (from) {
    res.cookies.set("basil_auth_from", from, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 600,
    });
  }
  return res;
}

// DELETE /api/auth/google — removes stored Google tokens for the current user
export async function DELETE() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  try {
    await deleteIntegrationToken(username, "google");
    // Flush immediately so the disconnected state survives any subsequent cold start.
    await forceFlushSnapshot();
    console.log(`[google/disconnect] Tokens deleted for user ${username}.`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[google/disconnect] Failed to delete tokens for user ${username}:`, msg);
    return NextResponse.json({ error: "Failed to disconnect Google" }, { status: 500 });
  }
}
