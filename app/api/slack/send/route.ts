import { NextResponse } from "next/server";
import { sendSlackMessage, sendSlackDM } from "@/lib/slack/client";
import { getSessionUser } from "@/lib/auth";

export async function POST(req: Request) {
  const username = (await getSessionUser());
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

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
      const result = await sendSlackDM(username, userId, message.trim());
      return NextResponse.json(result);
    }

    if (!channel?.trim()) {
      return NextResponse.json({ ok: false, error: "Channel or userId is required" }, { status: 400 });
    }

    const result = await sendSlackMessage(username, channel.trim(), message.trim());
    return NextResponse.json(result);
  } catch (e) {
    console.error("Slack send error:", e);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
