import { NextRequest, NextResponse } from "next/server";
import { getChannelHistory } from "@/lib/slack/client";

/**
 * GET /api/slack/history?channelId=...&limit=10
 * Returns the most recent N messages from a specific Slack channel/DM/group.
 * Used by the pinned-row expand UI in the Signals feed.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const channelId = searchParams.get("channelId");
  const limit = Number(searchParams.get("limit") || "10");

  if (!channelId) {
    return NextResponse.json({ error: "channelId required" }, { status: 400 });
  }

  const messages = await getChannelHistory(channelId, limit);
  return NextResponse.json({ channelId, messages });
}
