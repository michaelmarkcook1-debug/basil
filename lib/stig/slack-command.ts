import "server-only";

import { getRecentSlackMessages, type SlackMessage } from "@/lib/slack/client";

export interface SlackCommandData {
  generatedAt: string;
  totalMessages: number;
  needsReply: SlackMessage[];
  blockers: SlackMessage[];
  promises: SlackMessage[];
  staleThreads: SlackMessage[];
  channelHeatmap: Array<{ channel: string; count: number; mentions: number; blockers: number }>;
}

function looksBlocked(text: string): boolean {
  return /\b(blocked|blocker|stuck|waiting on|can'?t proceed|cannot proceed|at risk|risk|urgent|escalat)/i.test(text);
}

function looksLikeAsk(text: string): boolean {
  return /\b(can you|could you|please|need you|michael\?|thoughts\?|wdyt|approve|review|decide|sign off|ok to|are you able|do you want)\b/i.test(text);
}

function looksLikePromise(text: string): boolean {
  return /\b(i'll|i will|i can|i’m going to|i am going to|will send|will review|will follow up|let me|we should|we need to|todo|to do)\b/i.test(text);
}

function ageHours(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 3_600_000;
}

export async function buildSlackCommandCentre(username: string, limit = 80): Promise<SlackCommandData> {
  const messages = await getRecentSlackMessages(username, limit);

  const needsReply = messages
    .filter((m) => m.isMention || m.channelId?.startsWith("D") || looksLikeAsk(m.text))
    .slice(0, 12);

  const blockers = messages
    .filter((m) => looksBlocked(m.text))
    .slice(0, 12);

  const promises = messages
    .filter((m) => looksLikePromise(m.text))
    .slice(0, 12);

  const staleThreads = messages
    .filter((m) => (m.isMention || looksLikeAsk(m.text) || looksBlocked(m.text)) && ageHours(m.date) >= 18)
    .slice(0, 12);

  const channelHeatmap = Object.values(
    messages.reduce<Record<string, { channel: string; count: number; mentions: number; blockers: number }>>(
      (acc, m) => {
        acc[m.channel] ??= { channel: m.channel, count: 0, mentions: 0, blockers: 0 };
        acc[m.channel].count += 1;
        if (m.isMention || m.channelId?.startsWith("D")) acc[m.channel].mentions += 1;
        if (looksBlocked(m.text)) acc[m.channel].blockers += 1;
        return acc;
      },
      {}
    )
  )
    .sort((a, b) => (b.mentions + b.blockers * 2 + b.count / 10) - (a.mentions + a.blockers * 2 + a.count / 10))
    .slice(0, 10);

  return {
    generatedAt: new Date().toISOString(),
    totalMessages: messages.length,
    needsReply,
    blockers,
    promises,
    staleThreads,
    channelHeatmap,
  };
}

function formatMessages(label: string, messages: SlackMessage[]): string {
  if (messages.length === 0) return `### ${label}\nNo signal.`;
  return `### ${label}\n` + messages.slice(0, 8).map((m) => {
    const text = m.text.replace(/\s+/g, " ").slice(0, 220);
    return `- ${m.channel} · ${m.author} · ${m.date}: ${text}`;
  }).join("\n");
}

export function formatSlackCommandCentre(data: SlackCommandData): string {
  return [
    `## Slack Command Centre`,
    `Total recent Slack messages: ${data.totalMessages}`,
    formatMessages("Needs reply", data.needsReply),
    formatMessages("Team blockers", data.blockers),
    formatMessages("Promises / task language", data.promises),
    formatMessages("Stale threads", data.staleThreads),
    `### Channel heat\n${data.channelHeatmap.length ? data.channelHeatmap.map((c) => `- ${c.channel}: ${c.count} messages, ${c.mentions} direct/mention signals, ${c.blockers} blockers`).join("\n") : "No signal."}`,
  ].join("\n\n");
}
