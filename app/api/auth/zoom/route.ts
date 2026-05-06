import { NextResponse } from "next/server";
import { getZoomAuthUrl, disconnectZoom } from "@/lib/zoom/auth";
import { getSessionUser } from "@/lib/auth";
import { forceFlushSnapshot } from "@/lib/storage/persistent";

// GET /api/auth/zoom — redirects to Zoom OAuth consent screen
export async function GET(req: Request) {
  // Require an active session before starting the OAuth flow.
  const username = await getSessionUser();
  if (!username) {
    console.warn("[zoom/connect] Unauthenticated connect attempt — redirecting to login.");
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const from = new URL(req.url).searchParams.get("from") ?? "";
  const url  = getZoomAuthUrl();

  // Log the redirect URI being used so mismatches are visible in Vercel logs
  const clientId    = process.env.ZOOM_CLIENT_ID    ? "[set]" : "[MISSING]";
  const redirectUri = process.env.ZOOM_REDIRECT_URI ?? "[MISSING]";
  console.log(`[zoom/connect] Starting OAuth flow for user ${username} — client_id: ${clientId}, redirect_uri: ${redirectUri}`);

  const res  = NextResponse.redirect(url);
  if (from) res.cookies.set("basil_zoom_from", from, { path: "/", httpOnly: true, maxAge: 600 });
  return res;
}

// DELETE /api/auth/zoom — removes stored Zoom tokens for the current user
export async function DELETE() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  try {
    await disconnectZoom(username);
    await forceFlushSnapshot();
    console.log(`[zoom/disconnect] Tokens deleted for user ${username}.`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[zoom/disconnect] Failed to delete tokens for user ${username}:`, msg);
    return NextResponse.json({ error: "Failed to disconnect Zoom" }, { status: 500 });
  }
}
