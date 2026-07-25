import { NextResponse } from "next/server";
import { getStigRequestUser } from "@/lib/stig/auth";
import { isSlackConnected, getSlackConfig, getSlackUserClientForUser, getSlackBotClientForUser } from "@/lib/slack/client";
import { buildSlackCommandCentre, type SlackCommandData } from "@/lib/stig/slack-command";
import type { SlackMessage } from "@/lib/slack/client";

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
    const [data, slackConfig] = await Promise.all([
      Promise.race([buildSlackCommandCentre(username, 80), timeoutPromise]),
      getSlackConfig(username).catch(() => ({ teamId: undefined } as Awaited<ReturnType<typeof getSlackConfig>>)),
    ]) as [SlackCommandData, Awaited<ReturnType<typeof getSlackConfig>>];
    const windowEnd = now;
    const windowStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Deterministic "open in Slack" deep link — opens the exact DM/channel in the
    // Slack app/web where the user can read full context and reply. Needs only the
    // workspace id (stored at OAuth connect) + the conversation id (on each message);
    // no extra Slack API round-trip. Null when either is missing.
    const teamId = slackConfig.teamId;
    // Only emit a link for well-formed Slack ids (T…/C…/D…/G…, alphanumeric) and
    // url-encode them — channelId crosses the Slack-API boundary, so a malformed
    // value yields null rather than a broken/corrupted URL (defense-in-depth).
    const validSlackId = (v: string | undefined): v is string => !!v && /^[A-Z][A-Z0-9]+$/i.test(v);
    const slackLink = (m: { channelId?: string }): string | null =>
      validSlackId(teamId) && validSlackId(m.channelId)
        ? `https://app.slack.com/client/${encodeURIComponent(teamId)}/${encodeURIComponent(m.channelId)}`
        : null;

    // Message-anchored permalinks: opening a card previously always dropped the
    // user at the TOP of the conversation, forcing them to hunt for a 3-day-old
    // message. chat.getPermalink resolves the exact message (with the correct
    // workspace host — no need to store the workspace slug). Best-effort and
    // budget-capped: any failure/timeout just falls back to the conversation-level
    // link above, so this can never break the response.
    const allMessages: SlackMessage[] = [...data.needsReply, ...data.blockers, ...data.promises, ...data.staleThreads];
    const uniqueRefs = new Map<string, { channel: string; ts: string }>();
    for (const m of allMessages) {
      if (!m.channelId || !m.id) continue;
      uniqueRefs.set(`${m.channelId}:${m.id}`, { channel: m.channelId, ts: m.id });
    }
    // Cap fan-out — a few dozen messages is the realistic ceiling per page load;
    // beyond that, extra items just use the conversation-level fallback link.
    const refsToResolve = [...uniqueRefs.entries()].slice(0, 40);

    const permalinks = new Map<string, string>();
    if (refsToResolve.length > 0) {
      try {
        const web = (await getSlackUserClientForUser(username)) ?? (await getSlackBotClientForUser(username));
        if (web) {
          const PERMALINK_BUDGET_MS = 6_000;
          await Promise.race([
            Promise.allSettled(
              refsToResolve.map(async ([key, ref]) => {
                try {
                  const res = await web.chat.getPermalink({ channel: ref.channel, message_ts: ref.ts });
                  if (res.permalink) permalinks.set(key, res.permalink);
                } catch {
                  // Per-message failure (e.g. message deleted, rate-limited) — fall back silently.
                }
              })
            ),
            new Promise((resolve) => setTimeout(resolve, PERMALINK_BUDGET_MS)),
          ]);
        }
      } catch {
        // No Slack client available — every item falls back to slackLink(m) below.
      }
    }
    const messageLink = (m: SlackMessage): string | null =>
      (m.channelId && m.id && permalinks.get(`${m.channelId}:${m.id}`)) || slackLink(m);

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
        threadUrl: messageLink(m),
        people: [m.author],
        sourceKey: m.channelId ? `slack:${m.channelId}` : null,
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
        threadUrl: messageLink(m),
        people: [m.author],
        sourceKey: m.channelId ? `slack:${m.channelId}` : null,
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
        threadUrl: messageLink(m),
        people: [m.author],
        sourceKey: m.channelId ? `slack:${m.channelId}` : null,
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
        threadUrl: messageLink(m),
        people: [m.author],
        sourceKey: m.channelId ? `slack:${m.channelId}` : null,
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
