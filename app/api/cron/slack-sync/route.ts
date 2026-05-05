import { NextResponse } from "next/server";
import { getRecentSlackMessages } from "@/lib/slack/client";
import { getUsers } from "@/lib/users";
import { getSlackConfig } from "@/lib/slack/client";
import { writeUserStore, readUserStore } from "@/lib/storage/user-store";
import { HEALTH_META_FILE, type HealthMeta } from "@/lib/system/health";

// Vercel cron hits this every 10 minutes — warms the in-memory Slack cache
// for every user who has Slack connected, so dashboard loads are instant.
export async function GET(req: Request) {
  // Protect against non-cron callers in production
  const authHeader = req.headers.get("authorization");
  if (
    process.env.NODE_ENV === "production" &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const users = await getUsers();
  const results: Record<string, unknown> = {};
  let totalMessages = 0;

  for (const user of users) {
    const username = user.username;
    try {
      const config = await getSlackConfig(username);
      if (!config.botToken && !config.userToken) {
        // User doesn't have Slack connected — skip silently
        continue;
      }
      const messages = await getRecentSlackMessages(username, 200, 30);
      results[username] = { ok: true, count: messages.length };
      totalMessages += messages.length;
      console.log(`[slack-sync] ${username}: cached ${messages.length} messages`);
      // Write health metadata so the health panel can show "last Slack sync Xm ago"
      try {
        const existing = await readUserStore<HealthMeta>(username, HEALTH_META_FILE, {});
        await writeUserStore<HealthMeta>(username, HEALTH_META_FILE, {
          ...existing,
          lastSlackSyncAt: new Date().toISOString(),
        });
      } catch (metaErr) {
        console.warn(`[slack-sync] Failed to write health-meta for ${username}:`, metaErr instanceof Error ? metaErr.message : metaErr);
      }
    } catch (e) {
      results[username] = { ok: false, error: String(e) };
      console.error(`[slack-sync] Error for ${username}:`, e);
    }
  }

  return NextResponse.json({
    ok: true,
    totalMessages,
    refreshed: new Date().toISOString(),
    users: results,
  });
}
