import { NextResponse } from "next/server";
import { getMicrosoftAuthUrl } from "@/lib/microsoft/auth";
import { getSessionUser } from "@/lib/auth";
import { deleteIntegrationToken } from "@/lib/storage/secure-token-store";
import { forceFlushSnapshot } from "@/lib/storage/persistent";

// GET /api/auth/microsoft — redirects to Microsoft OAuth consent screen
export async function GET(req: Request) {
  if (!process.env.MICROSOFT_CLIENT_ID) {
    console.warn("[microsoft-auth] MICROSOFT_CLIENT_ID not configured — redirecting to settings");
    const settingsUrl = new URL("/dashboard/settings?error=microsoft_not_configured", req.url);
    return NextResponse.redirect(settingsUrl);
  }

  // Derive the app base URL from the incoming request so OAuth works on any
  // Vercel preview URL without requiring MICROSOFT_REDIRECT_URI / NEXT_PUBLIC_APP_URL.
  const reqUrl = new URL(req.url);
  const from = reqUrl.searchParams.get("from") ?? "";
  const url = getMicrosoftAuthUrl(reqUrl.origin);
  const res = NextResponse.redirect(url);
  if (from) res.cookies.set("basil_auth_from", from, { path: "/", httpOnly: true, maxAge: 600 });
  return res;
}

// DELETE /api/auth/microsoft — removes stored Microsoft tokens for the current user
export async function DELETE() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  await deleteIntegrationToken(username, "microsoft");
  await forceFlushSnapshot();
  return NextResponse.json({ ok: true });
}
