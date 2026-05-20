import { NextResponse } from "next/server";
import { isSlackConnected, getRecentSlackMessages } from "@/lib/slack/client";
import { getSessionUser } from "@/lib/auth";
import { listEvents } from "@/lib/events/store";

// AG-related keywords for prioritisation
const AG_KEYWORDS = [
  "analyst", "analystgenius", "ag ", "ag-", "analyst genius",
  "boardradar", "v1.0", "v1", "dashboard", "analyst relations",
];

export async function GET() {
  const username = (await getSessionUser());
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  if (!(await isSlackConnected(username))) {
    return NextResponse.json({
      connected: false,
      messages: [],
      message: "Slack not connected. Add bot token in Settings.",
    });
  }

  try {
    // Fetch messages from the last 3 days max — keeps results fresh
    const allMessages = await getRecentSlackMessages(username, 30, 3);

    // For DMs: keep only the most recent message per conversation to avoid
    // 3 consecutive "DM: Ed Baum" entries. For channels: keep all (different topics).
    const dmSeen = new Map<string, boolean>();
    const dedupedDMs: typeof allMessages = [];
    const channelMsgs: typeof allMessages = [];

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

      if (isDM) score += 20;

      if (AG_KEYWORDS.some((kw) => textLower.includes(kw) || channelLower.includes(kw))) score += 50;
      if (msg.isMention) score += 30;
      if (channelLower.includes("ag-") || channelLower.includes("ag_")) score += 40;

      const ageHours = (Date.now() - new Date(msg.date).getTime()) / 3600000;
      if (ageHours < 4) score += 40;
      else if (ageHours < 12) score += 25;
      else if (ageHours < 24) score += 15;
      else if (ageHours < 48) score += 5;

      return { ...msg, score };
    }

    const scoredDMs = dedupedDMs.map((m) => scoreMsg(m, true)).sort((a, b) => b.score - a.score);
    const scoredChannels = channelMsgs.map((m) => scoreMsg(m, false)).sort((a, b) => b.score - a.score);

    const maxPerBucket = 4;
    const topDMs = scoredDMs.slice(0, maxPerBucket);
    const topChannels = scoredChannels.slice(0, maxPerBucket);

    const remaining = 8 - topDMs.length - topChannels.length;
    const extraDMs = scoredDMs.slice(maxPerBucket, maxPerBucket + Math.max(0, remaining));
    const extraChannels = scoredChannels.slice(
      maxPerBucket,
      maxPerBucket + Math.max(0, 8 - topDMs.length - topChannels.length - extraDMs.length)
    );

    const merged = [...topDMs, ...extraDMs, ...topChannels, ...extraChannels];
    merged.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    const topMessages = merged.slice(0, 8).map(({ score: _score, ...msg }) => msg);

    // Enrich with analysis status by cross-referencing events store
    const events = await listEvents(username);
    const eventByRef = new Map<string, { analysed: boolean; materialized: boolean }>();
    for (const ev of events) {
      const ref = ev.sourceRef ?? ev.externalId;
      if (!ref) continue;
      const materialized = !!(ev.actionId || ev.decisionId || ev.memoryId ||
        ev.status === "executed" || ev.status === "approved");
      eventByRef.set(ref, { analysed: true, materialized });
    }

    const enriched = topMessages.map((m) => {
      const ref = m.channelId ? `slack:${m.channelId}:${m.id}` : undefined;
      const ev = ref ? eventByRef.get(ref) : undefined;
      return {
        ...m,
        analysed: ev?.analysed ?? false,
        materialized: ev?.materialized ?? false,
      };
    });

    return NextResponse.json({
      connected: true,
      messages: enriched,
      message: enriched.length === 0 ? "No recent messages." : `${enriched.length} highlights.`,
    });
  } catch {
    return NextResponse.json({
      connected: false,
      messages: [],
      message: "Slack error — please try again",
    });
  }
}
