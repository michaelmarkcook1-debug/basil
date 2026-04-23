import { NextResponse } from "next/server";
import { sendSlackMessage, sendSlackDM } from "@/lib/slack/client";

export async function POST(req: Request) {
  try {
    const { channel, message, userId } = await req.json() as {
      channel?: string;
      message?: string;
      userId?: string;
    };

    if (!message?.trim()) {
      return NextResponse.json({ ok: false, error: "Message is required" }, { status: 400 });
    }

    // Direct DM by Slack user ID
    if (userId) {
      const result = await sendSlackDM(userId, message.trim());
      return NextResponse.json(result);
    }

    if (!channel?.trim()) {
      return NextResponse.json({ ok: false, error: "Channel or userId is required" }, { status: 400 });
    }

    // Channel name or display name (sendSlackMessage handles lookup)
    const result = await sendSlackMessage(channel.trim(), message.trim());
    return NextResponse.json(result);
  } catch (e) {
    console.error("Slack send error:", e);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
