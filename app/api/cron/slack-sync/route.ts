import { NextResponse } from "next/server";
import { getRecentSlackMessages } from "@/lib/slack/client";

// Vercel cron hits this every 10 minutes — warms the in-memory Slack cache
// so dashboard loads are instant rather than waiting on Slack API.
export async function GET(req: Request) {
  // Protect against non-cron callers in production
  const authHeader = req.headers.get("authorization");
  if (
    process.env.NODE_ENV === "production" &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // TODO: iterate over all registered users instead of hardcoding admin
    const messages = await getRecentSlackMessages("michael", 200, 30);
    return NextResponse.json({
      ok: true,
      count: messages.length,
      refreshed: new Date().toISOString(),
    });
  } catch (e) {
    console.error("Slack sync cron error:", e);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
