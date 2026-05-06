import { NextResponse } from "next/server";
import { getAuthUrl } from "@/lib/google/auth";
import { getSessionUser } from "@/lib/auth";
import { deleteIntegrationToken } from "@/lib/storage/secure-token-store";
import { forceFlushSnapshot } from "@/lib/storage/persistent";

// GET /api/auth/google — redirects to Google OAuth consent screen
export async function GET(req: Request) {
  // Require an active session before starting the OAuth flow.
  // Without this guard, the callback cannot save tokens (no username).
  const username = await getSessionUser();
  if (!username) {
    console.warn("[google/connect] Unauthenticated connect attempt — redirecting to login.");
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const from = new URL(req.url).searchParams.get("from") ?? "";
  const url = getAuthUrl();
  console.log(`[google/connect] Starting OAuth flow for user ${username}.`);
  const res = NextResponse.redirect(url);
  if (from) res.cookies.set("basil_auth_from", from, { path: "/", httpOnly: true, maxAge: 600 });
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
