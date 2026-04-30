import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { saveSlackConfig } from "@/lib/slack/client";
import { forceFlushSnapshot } from "@/lib/storage/persistent";

/**
 * GET /api/auth/slack/callback
 *
 * Handles the Slack OAuth v2 callback. Exchanges the authorization code
 * for bot + user access tokens and saves them to the user's scoped store.
 *
 * Required env vars:
 *   SLACK_CLIENT_ID
 *   SLACK_CLIENT_SECRET
 *   SLACK_REDIRECT_URI
 */

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const code  = searchParams.get("code");
  const error = searchParams.get("error");

  const from = req.headers.get("cookie")?.match(/basil_slack_from=([^;]+)/)?.[1] ?? "";
  const successDest = from === "onboarding"
    ? "/onboarding?connected=slack"
    : "/dashboard/settings?connected=slack";
  const errorDest = from === "onboarding"
    ? "/onboarding?error=slack_auth"
    : "/dashboard/settings?error=slack_auth";

  const clearFromCookie = (res: NextResponse) => {
    res.cookies.set("basil_slack_from", "", { path: "/", maxAge: 0 });
    return res;
  };

  if (error || !code) {
    console.error("Slack OAuth error param:", error);
    return clearFromCookie(NextResponse.redirect(new URL(errorDest, req.url)));
  }

  const username = await getSessionUser();
  if (!username) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const clientId     = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  const redirectUri  =
    process.env.SLACK_REDIRECT_URI ||
    `${new URL(req.url).origin}/api/auth/slack/callback`;

  if (!clientId || !clientSecret) {
    console.error("Slack OAuth: SLACK_CLIENT_ID or SLACK_CLIENT_SECRET not set");
    return clearFromCookie(NextResponse.redirect(new URL(errorDest, req.url)));
  }

  try {
    // Exchange code for tokens
    const tokenRes = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id:     clientId,
        client_secret: clientSecret,
        code,
        redirect_uri:  redirectUri,
      }),
    });

    const data = await tokenRes.json() as {
      ok: boolean;
      error?: string;
      access_token?: string;          // bot token
      authed_user?: { access_token?: string }; // user token
    };

    if (!data.ok) {
      console.error("Slack oauth.v2.access error:", data.error);
      // Pass the actual Slack error code to the settings page for debugging
      const dest = from === "onboarding"
        ? `/onboarding?error=slack_auth&slack_error=${encodeURIComponent(data.error ?? "unknown")}`
        : `/dashboard/settings?error=slack_auth&slack_error=${encodeURIComponent(data.error ?? "unknown")}`;
      return clearFromCookie(NextResponse.redirect(new URL(dest, req.url)));
    }

    await saveSlackConfig(username, {
      botToken:  data.access_token,
      userToken: data.authed_user?.access_token,
    });
    await forceFlushSnapshot();

    return clearFromCookie(NextResponse.redirect(new URL(successDest, req.url)));
  } catch (e) {
    console.error("Slack OAuth callback error:", e);
    return clearFromCookie(NextResponse.redirect(new URL(errorDest, req.url)));
  }
}
