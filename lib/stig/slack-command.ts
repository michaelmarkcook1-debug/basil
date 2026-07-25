import "server-only";

import { getRecentSlackMessages, type SlackMessage } from "@/lib/slack/client";
import { getMutedSourceKeys } from "@/lib/learning/store";

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
  // "at risk" stays; bare "risk" is removed — it matched ordinary sentences
  // ("no risk", "risk appetite", "de-risk") and manufactured false criticals.
  return /\b(blocked|blocker|stuck|waiting on|can'?t proceed|cannot proceed|at risk|urgent|escalat)/i.test(text);
}

function looksLikePromise(text: string): boolean {
  return /\b(i'll|i will|i can|i’m going to|i am going to|will send|will review|will follow up|let me|we should|we need to|todo|to do)\b/i.test(text);
}

function ageHours(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 3_600_000;
}

export async function buildSlackCommandCentre(username: string, limit = 80): Promise<SlackCommandData> {
  const [allMessages, mutedKeys] = await Promise.all([
    getRecentSlackMessages(username, limit),
    getMutedSourceKeys(username).catch(() => new Set<string>()),
  ]);
  // Respect per-contact / per-channel mutes — the user's "silence this" option.
  // Keyed by `slack:<channelId>` (same store as the learning loop), so a muted
  // DM/channel is dropped from every signal below. Nothing is muted by default;
  // this only applies once the user explicitly mutes a source.
  const messages = allMessages.filter(
    (m) => !(m.channelId && mutedKeys.has(`slack:${m.channelId}`))
  );

  // "Awaiting your reply" = a message NOT sent by you, that is either an @-mention
  // of you OR is in a DM / group-DM you're part of (channelMembers is only set for
  // DMs/group-DMs). Plain channel chatter you're a nominal member of — but not
  // mentioned in — is NOT yours to reply to, so it's excluded.
  // Conversation-level: consider only the NEWEST message per conversation
  // (messages are sorted newest-first). If that newest message is from YOU, you
  // have already replied — the conversation is NOT awaiting your reply. This
  // fixes the "you answered a minute ago but it still shows reply-needed / stale
  // for 7 days" bug, and stops a busy DM from spamming one card per message.
  const newestPerConversation: SlackMessage[] = [];
  const seenConversations = new Set<string>();
  for (const m of messages) {
    const key = m.channelId ?? m.channel;
    if (seenConversations.has(key)) continue;
    seenConversations.add(key);
    newestPerConversation.push(m);
  }

  const needsReply = newestPerConversation
    .filter((m) => !m.fromSelf && (m.isMention || m.channelMembers !== undefined))
    .slice(0, 12);

  // Blockers / promises exclude YOUR OWN messages: your "this is urgent" is not a
  // team blocker to chase, and your own "I'll send it over" is not a promise to
  // hunt down. Without this, the user's own words came back as red criticals.
  const blockers = messages
    .filter((m) => !m.fromSelf && looksBlocked(m.text))
    .slice(0, 12);

  const promises = messages
    .filter((m) => !m.fromSelf && looksLikePromise(m.text))
    .slice(0, 12);

  // Stale = a conversation whose newest message is an unanswered inbound one >18h old.
  const staleThreads = newestPerConversation
    .filter((m) => !m.fromSelf && (m.isMention || m.channelMembers !== undefined || looksBlocked(m.text)) && ageHours(m.date) >= 18)
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
