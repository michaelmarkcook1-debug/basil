import { NextResponse } from "next/server";
import { getMicrosoftAuthUrl } from "@/lib/microsoft/auth";
import { getSessionUser } from "@/lib/auth";
import { deleteIntegrationToken } from "@/lib/storage/secure-token-store";
import { forceFlushSnapshot } from "@/lib/storage/persistent";

// GET /api/auth/microsoft — redirects to Microsoft OAuth consent screen
export async function GET(req: Request) {
  // Require an active session before starting the OAuth flow.
  // Without this guard, the callback cannot save tokens (no username).
  const username = await getSessionUser();
  if (!username) {
    console.warn("[microsoft/connect] Unauthenticated connect attempt — redirecting to login.");
    return NextResponse.redirect(new URL("/login", req.url));
  }

  if (!process.env.MICROSOFT_CLIENT_ID) {
    console.warn("[microsoft/connect] MICROSOFT_CLIENT_ID not configured — redirecting to settings");
    return NextResponse.redirect(new URL("/dashboard/settings?error=microsoft_not_configured", req.url));
  }

  // Derive the app base URL from the incoming request so OAuth works on any
  // Vercel preview URL without requiring MICROSOFT_REDIRECT_URI / NEXT_PUBLIC_APP_URL.
  const reqUrl = new URL(req.url);
  const from = reqUrl.searchParams.get("from") ?? "";
  const url = getMicrosoftAuthUrl(reqUrl.origin);
  console.log(`[microsoft/connect] Starting OAuth flow for user ${username}.`);
  const res = NextResponse.redirect(url);
  if (from) res.cookies.set("basil_auth_from", from, { path: "/", httpOnly: true, maxAge: 600 });
  return res;
}

// DELETE /api/auth/microsoft — removes stored Microsoft tokens for the current user
export async function DELETE() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  try {
    await deleteIntegrationToken(username, "microsoft");
    await forceFlushSnapshot();
    console.log(`[microsoft/disconnect] Tokens deleted for user ${username}.`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[microsoft/disconnect] Failed to delete tokens for user ${username}:`, msg);
    return NextResponse.json({ error: "Failed to disconnect Microsoft" }, { status: 500 });
  }
}
