import { NextResponse } from "next/server";
import { exchangeZoomCode } from "@/lib/zoom/auth";
import { getSessionUser } from "@/lib/auth";
import { forceFlushSnapshot } from "@/lib/storage/persistent";

// GET /api/auth/zoom/callback — handles Zoom OAuth callback
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");

  if (!code) {
    return NextResponse.redirect(new URL("/dashboard/settings?error=no_code", req.url));
  }

  const fromRaw = req.headers.get("cookie")?.match(/basil_zoom_from=([^;]+)/)?.[1] ?? "";
  const fromDecoded = fromRaw ? decodeURIComponent(fromRaw) : "";
  // Validate that `from` is a relative path (no protocol/host) to prevent open redirects
  const isSafePath = fromDecoded.startsWith("/") && !fromDecoded.startsWith("//");
  const successDest = isSafePath ? fromDecoded : "/dashboard/settings?connected=zoom";
  const errorDest   = "/dashboard/settings?error=zoom_oauth_failed";

  try {
    // Session must be present on the callback — no fallback to any hardcoded user.
    // If the session cookie was lost (rare cross-domain edge case), the user must
    // restart the OAuth flow from within the app while logged in.
    const username = await getSessionUser();
    if (!username) {
      const res = NextResponse.redirect(new URL("/login?error=session_expired", req.url));
      res.cookies.set("basil_zoom_from", "", { path: "/", maxAge: 0 });
      return res;
    }
    await exchangeZoomCode(code, username);
    await forceFlushSnapshot();
    const res = NextResponse.redirect(new URL(successDest, req.url));
    res.cookies.set("basil_zoom_from", "", { path: "/", maxAge: 0 });
    return res;
  } catch (e) {
    console.error("Zoom OAuth error:", e);
    const res = NextResponse.redirect(new URL(errorDest, req.url));
    res.cookies.set("basil_zoom_from", "", { path: "/", maxAge: 0 });
    return res;
  }
}
