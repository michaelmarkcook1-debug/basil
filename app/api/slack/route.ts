import { NextResponse } from "next/server";
import { getSlackClient, getSlackUserClient, getRecentSlackMessages } from "@/lib/slack/client";

// AG-related keywords for prioritisation
const AG_KEYWORDS = [
  "analyst", "analystgenius", "ag ", "ag-", "analyst genius",
  "boardradar", "v1.0", "v1", "dashboard", "analyst relations",
];

export async function GET() {
  const client = getSlackClient() || getSlackUserClient();

  if (!client) {
    return NextResponse.json({
      connected: false,
      messages: [],
      message: "Slack not connected. Add bot token in Settings.",
    });
  }

  try {
    // Fetch messages from the last 3 days max — keeps results fresh
    const allMessages = await getRecentSlackMessages(30, 3);

    // For DMs: keep only the most recent message per conversation to avoid
    // 3 consecutive "DM: Ed Baum" entries. For channels: keep all (different topics).
    const dmSeen = new Map<string, boolean>();
    const dedupedDMs: typeof allMessages = [];
    const channelMsgs: typeof allMessages = [];

    // allMessages is already sorted newest-first from the client
    for (const m of allMessages) {
      const isDM = m.channel.startsWith("DM:") || m.channel === "Group DM";
      if (isDM) {
        if (!dmSeen.has(m.channel)) {
          dmSeen.set(m.channel, true);
          dedupedDMs.push(m);
        }
      } else {
        channelMsgs.push(m);
      }
    }

    function scoreMsg(msg: typeof allMessages[number], isDM: boolean) {
      let score = 0;
      const textLower = msg.text.toLowerCase();
      const channelLower = msg.channel.toLowerCase();

      if (isDM) score += 20; // mild DM boost within its own bucket

      // AG-related content
      if (AG_KEYWORDS.some((kw) => textLower.includes(kw) || channelLower.includes(kw))) score += 50;

      // Mentions of Michael
      if (msg.isMention) score += 30;

      // AG channels
      if (channelLower.includes("ag-") || channelLower.includes("ag_")) score += 40;

      // Recency bonus — strongly prefer recent messages
      const ageHours = (Date.now() - new Date(msg.date).getTime()) / 3600000;
      if (ageHours < 4) score += 40;
      else if (ageHours < 12) score += 25;
      else if (ageHours < 24) score += 15;
      else if (ageHours < 48) score += 5;

      return { ...msg, score };
    }

    const scoredDMs = dedupedDMs.map((m) => scoreMsg(m, true)).sort((a, b) => b.score - a.score);
    const scoredChannels = channelMsgs.map((m) => scoreMsg(m, false)).sort((a, b) => b.score - a.score);

    // Take up to 4 from each bucket, backfill if one has fewer
    const maxPerBucket = 4;
    const topDMs = scoredDMs.slice(0, maxPerBucket);
    const topChannels = scoredChannels.slice(0, maxPerBucket);

    // Backfill: if DMs < 4, give extra slots to channels and vice versa
    const remaining = 8 - topDMs.length - topChannels.length;
    const extraDMs = scoredDMs.slice(maxPerBucket, maxPerBucket + Math.max(0, remaining));
    const extraChannels = scoredChannels.slice(
      maxPerBucket,
      maxPerBucket + Math.max(0, 8 - topDMs.length - topChannels.length - extraDMs.length)
    );

    const merged = [...topDMs, ...extraDMs, ...topChannels, ...extraChannels];
    // Final sort: most recent first for display
    merged.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    const topMessages = merged.slice(0, 8).map(({ score, ...msg }) => msg);

    return NextResponse.json({
      connected: true,
      messages: topMessages,
      message: topMessages.length === 0 ? "No recent messages." : `${topMessages.length} highlights.`,
    });
  } catch (e) {
    return NextResponse.json({
      connected: false,
      messages: [],
      message: `Slack error: ${e instanceof Error ? e.message : "Unknown error"}`,
    });
  }
}
