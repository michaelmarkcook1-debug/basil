import { NextResponse } from "next/server";
import { getZoomAuthUrl, disconnectZoom } from "@/lib/zoom/auth";
import { getSessionUser } from "@/lib/auth";
import { forceFlushSnapshot } from "@/lib/storage/persistent";
import { buildOAuthState } from "@/lib/auth/oauth-state";

// GET /api/auth/zoom — redirects to Zoom OAuth consent screen
export async function GET(req: Request) {
  // Guard: require a valid session before starting the OAuth flow.
  // Without this check an unauthenticated user would complete Zoom's consent
  // screen only to land at /login?error=session_expired in the callback.
  const username = await getSessionUser();
  if (!username) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("next", "/dashboard/settings");
    return NextResponse.redirect(loginUrl);
  }

  const from = new URL(req.url).searchParams.get("from") ?? "";
  const st = buildOAuthState("zoom");
  const url = `${getZoomAuthUrl()}&state=${encodeURIComponent(st.state)}`;

  // Log the redirect URI being used so mismatches are visible in Vercel logs
  const clientId    = process.env.ZOOM_CLIENT_ID    ? "[set]" : "[MISSING]";
  const redirectUri = process.env.ZOOM_REDIRECT_URI ?? "[MISSING]";
  console.log(`[zoom-oauth] Initiating OAuth — user: ${username}, client_id: ${clientId}, redirect_uri: ${redirectUri}`);

  const res  = NextResponse.redirect(url);
  res.cookies.set(st.name, st.value, st.options);
  if (from) res.cookies.set("basil_zoom_from", from, { path: "/", httpOnly: true, maxAge: 600 });
  return res;
}

// DELETE /api/auth/zoom — removes stored Zoom tokens for the current user
export async function DELETE() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  await disconnectZoom(username);
  await forceFlushSnapshot();
  return NextResponse.json({ ok: true });
}
