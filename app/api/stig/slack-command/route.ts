import { NextResponse } from "next/server";
import { getStigRequestUser } from "@/lib/stig/auth";
import { isSlackConnected } from "@/lib/slack/client";
import { buildSlackCommandCentre } from "@/lib/stig/slack-command";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request) {
  const user = await getStigRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { username } = user;
  const now = new Date().toISOString();

  // Check env vars first
  const hasSlackEnv = !!(process.env.SLACK_CLIENT_ID || process.env.SLACK_BOT_TOKEN);
  if (!hasSlackEnv) {
    return NextResponse.json({
      status: "missing_env",
      generatedAt: now,
      window: null,
      summary: { replyNeeded: 0, blockers: 0, promises: 0, decisions: 0, staleThreads: 0, hotChannels: 0 },
      signals: [],
      diagnostics: { slackConnected: false, messageCount: 0, missingEnv: ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"] },
    });
  }

  const connected = await isSlackConnected(username);
  if (!connected) {
    return NextResponse.json({
      status: "not_connected",
      generatedAt: now,
      window: null,
      summary: { replyNeeded: 0, blockers: 0, promises: 0, decisions: 0, staleThreads: 0, hotChannels: 0 },
      signals: [],
      diagnostics: { slackConnected: false, messageCount: 0 },
    });
  }

  try {
    const TIMEOUT_MS = 25_000;
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Slack command timeout after 25s")), TIMEOUT_MS)
    );
    const data = await Promise.race([buildSlackCommandCentre(username, 80), timeoutPromise]);
    const windowEnd = now;
    const windowStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Convert legacy format to new signal format
    const signals = [
      ...data.needsReply.map((m, i) => ({
        id: `reply-${i}`,
        type: "reply_needed" as const,
        title: `Reply needed: ${m.author}`,
        summary: m.text.slice(0, 200),
        whyItMatters: "You were mentioned or asked a question",
        recommendedAction: "Reply to this message",
        channelName: m.channel,
        threadUrl: null,
        people: [m.author],
        source: "slack" as const,
        confidence: 0.8,
        urgency: m.isMention ? "high" : "medium",
        createdAt: m.date,
        lastActivityAt: m.date,
      })),
      ...data.blockers.map((m, i) => ({
        id: `blocker-${i}`,
        type: "blocker" as const,
        title: `Blocker: ${m.channel}`,
        summary: m.text.slice(0, 200),
        whyItMatters: "Blocking language detected",
        recommendedAction: "Address this blocker",
        channelName: m.channel,
        threadUrl: null,
        people: [m.author],
        source: "slack" as const,
        confidence: 0.75,
        urgency: "high",
        createdAt: m.date,
        lastActivityAt: m.date,
      })),
      ...data.promises.map((m, i) => ({
        id: `promise-${i}`,
        type: "promise_made" as const,
        title: `Promise: ${m.author}`,
        summary: m.text.slice(0, 200),
        whyItMatters: "Commitment language detected",
        recommendedAction: "Ensure this promise is tracked",
        channelName: m.channel,
        threadUrl: null,
        people: [m.author],
        source: "slack" as const,
        confidence: 0.7,
        urgency: "medium",
        createdAt: m.date,
        lastActivityAt: m.date,
      })),
      ...data.staleThreads.map((m, i) => ({
        id: `stale-${i}`,
        type: "stale_thread" as const,
        title: `Stale thread: ${m.channel}`,
        summary: m.text.slice(0, 200),
        whyItMatters: "No response in 18+ hours",
        recommendedAction: "Follow up on this thread",
        channelName: m.channel,
        threadUrl: null,
        people: [m.author],
        source: "slack" as const,
        confidence: 0.65,
        urgency: "low",
        createdAt: m.date,
        lastActivityAt: m.date,
      })),
    ];

    return NextResponse.json({
      status: data.totalMessages > 0 ? "ready" : "empty",
      generatedAt: data.generatedAt,
      window: { from: windowStart, to: windowEnd, timezone: "Europe/London" },
      summary: {
        replyNeeded: data.needsReply.length,
        blockers: data.blockers.length,
        promises: data.promises.length,
        decisions: 0,
        staleThreads: data.staleThreads.length,
        hotChannels: data.channelHeatmap.length,
      },
      signals,
      diagnostics: { slackConnected: true, messageCount: data.totalMessages },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[stig/slack-command] error:", msg);
    return NextResponse.json({
      status: "error",
      generatedAt: now,
      window: null,
      summary: { replyNeeded: 0, blockers: 0, promises: 0, decisions: 0, staleThreads: 0, hotChannels: 0 },
      signals: [],
      diagnostics: { slackConnected: true, messageCount: 0, error: msg },
    }, { status: 500 });
  }
}
