import { NextResponse } from "next/server";
import { getMicrosoftAuthUrl } from "@/lib/microsoft/auth";

// GET /api/auth/microsoft — redirects to Microsoft OAuth consent screen
export async function GET(req: Request) {
  if (!process.env.MICROSOFT_CLIENT_ID) {
    console.warn("[microsoft-auth] MICROSOFT_CLIENT_ID not configured — redirecting to settings");
    const settingsUrl = new URL("/dashboard/settings?error=microsoft_not_configured", req.url);
    return NextResponse.redirect(settingsUrl);
  }

  // Derive the app base URL from the incoming request so OAuth works on any
  // Vercel preview URL without requiring MICROSOFT_REDIRECT_URI / NEXT_PUBLIC_APP_URL.
  const { origin } = new URL(req.url);
  const url = getMicrosoftAuthUrl(origin);
  console.log(`[microsoft-auth] Initiating OAuth → redirect_uri: ${origin}/api/auth/microsoft/callback`);
  return NextResponse.redirect(url);
}
