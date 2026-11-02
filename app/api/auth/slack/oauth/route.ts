import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { buildOAuthState } from "@/lib/auth/oauth-state";

/**
 * GET /api/auth/slack/oauth
 *
 * Initiates the Slack OAuth v2 flow. Redirects the user to Slack's
 * consent screen. After approval, Slack redirects to /api/auth/slack/callback.
 *
 * Required env vars:
 *   SLACK_CLIENT_ID
 *   SLACK_REDIRECT_URI  (default: https://basil-app.vercel.app/api/auth/slack/callback)
 */

// Bot scopes — needed for channels, DMs, sending messages
const BOT_SCOPES = [
  "channels:read",
  "channels:history",
  "groups:read",
  "groups:history",
  "im:read",
  "im:history",
  "mpim:read",
  "mpim:history",
  "users:read",
  "users:read.email",
  "chat:write",
].join(",");

// User scopes — the reader works from the user's own token: it lists the
// conversations they are in (conversations.list → the :read scopes), reads
// them (:history) and searches (search:read, user tokens only). Without the
// :read scopes every OAuth-connected user got missing_scope on every fetch
// (2026-11-02, Guy's first connect); the owner's env token had them.
const USER_SCOPES = [
  "channels:read",
  "channels:history",
  "groups:read",
  "groups:history",
  "im:read",
  "im:history",
  "mpim:read",
  "mpim:history",
  "users:read",
  "search:read",
].join(",");

export async function GET(req: Request) {
  const username = await getSessionUser();
  if (!username) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const clientId = process.env.SLACK_CLIENT_ID;
  if (!clientId) {
    // No Slack app configured — redirect back with error
    const from = new URL(req.url).searchParams.get("from") ?? "";
    const dest  = from === "onboarding" ? "/onboarding" : "/dashboard/settings";
    return NextResponse.redirect(new URL(`${dest}?error=slack_not_configured`, req.url));
  }

  const redirectUri =
    process.env.SLACK_REDIRECT_URI ||
    `${new URL(req.url).origin}/api/auth/slack/callback`;

  const from = new URL(req.url).searchParams.get("from") ?? "";

  const st = buildOAuthState("slack");
  const slackUrl = new URL("https://slack.com/oauth/v2/authorize");
  slackUrl.searchParams.set("client_id", clientId);
  slackUrl.searchParams.set("scope", BOT_SCOPES);
  slackUrl.searchParams.set("user_scope", USER_SCOPES);
  slackUrl.searchParams.set("redirect_uri", redirectUri);
  slackUrl.searchParams.set("state", st.state);

  const res = NextResponse.redirect(slackUrl.toString());
  res.cookies.set(st.name, st.value, st.options);
  // Remember where to send the user after OAuth completes
  if (from) {
    res.cookies.set("basil_slack_from", from, { path: "/", httpOnly: true, maxAge: 600 });
  }
  return res;
}
