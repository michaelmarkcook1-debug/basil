import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isSlackConnected } from "@/lib/slack/client";
import { buildSlackCommandCentre } from "@/lib/stig/slack-command";

export const maxDuration = 30;

export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  // Check connection first before attempting the expensive build
  const connected = await isSlackConnected(username);
  if (!connected) {
    return NextResponse.json(
      { code: "SLACK_NOT_CONNECTED", error: "Slack is not connected. Connect a workspace in Settings.", status: "not_connected" },
      { status: 422 }
    );
  }

  try {
    const data = await buildSlackCommandCentre(username, 80);
    return NextResponse.json(data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[slack-command] GET error:", msg);
    const isNotConfigured =
      msg.toLowerCase().includes("not configured") ||
      msg.toLowerCase().includes("workspace") ||
      msg.toLowerCase().includes("no slack") ||
      msg.toLowerCase().includes("token");
    if (isNotConfigured) {
      return NextResponse.json(
        { code: "SLACK_NOT_CONNECTED", error: "Slack workspace not connected" },
        { status: 422 }
      );
    }
    return NextResponse.json({ error: "Failed to build Slack command centre" }, { status: 500 });
  }
}
