/**
 * Fetch a Slack thread (parent message + all replies) as a normalized
 * plain-text transcript for AI classification.
 *
 * Why threads, not single messages?  A message like "Let's go with Option B"
 * is meaningless without its thread.  Thread-level context lets the classifier
 * understand decisions, blockers, and ownership accurately.
 *
 * Cost controls:
 * - Cap: 20 messages per thread.
 * - Per-message text: 500 chars (Slack messages are short; this is generous).
 * - Total transcript: capped to 6 000 chars before passing to the AI.
 *
 * Safety: never throws — returns empty array / empty string on any failure.
 */

import type { WebClient } from "@slack/web-api";
import { getSlackBotClient, getSlackUserClient } from "./client";

const MAX_THREAD_MESSAGES = 20;
const MAX_CHARS_PER_MSG = 500;
const MAX_TRANSCRIPT_CHARS = 6_000;

// Shared name cache (same pattern as client.ts — avoids redundant API calls)
const userNameCache = new Map<string, string>();

async function resolveUserName(web: WebClient, userId: string): Promise<string> {
  if (userNameCache.has(userId)) return userNameCache.get(userId)!;
  try {
    const info = await web.users.info({ user: userId });
    const name = info.user?.real_name || info.user?.name || userId;
    userNameCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

function cleanText(text: string): string {
  return text
    .replace(/<@(\w+)>/g, (_, uid) => `@${userNameCache.get(uid) || uid}`)
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim()
    .slice(0, MAX_CHARS_PER_MSG);
}

export interface SlackThreadMessage {
  author: string;
  text: string;
  ts: string;
  isParent: boolean;
}

/**
 * Fetch all messages in a Slack thread.
 * If the message has no replies, returns just the parent message.
 * Returns empty array on any API failure.
 */
export async function fetchSlackThread(
  channelId: string,
  messageTs: string
): Promise<SlackThreadMessage[]> {
  const web = getSlackUserClient() || getSlackBotClient();
  if (!web) return [];
  const lookupWeb = getSlackBotClient() || web;

  try {
    const res = await web.conversations.replies({
      channel: channelId,
      ts: messageTs,
      limit: MAX_THREAD_MESSAGES + 1, // +1 so we know if there are more
    });

    const messages = res.messages || [];
    const result: SlackThreadMessage[] = [];

    for (const msg of messages.slice(0, MAX_THREAD_MESSAGES)) {
      // Skip edits, joins, and other system subtypes — human text only.
      // Cast needed: conversations.replies MessageElement type omits subtype
      // but the field is present at runtime for system messages.
      if ((msg as { subtype?: string }).subtype) continue;
      const authorName = msg.user
        ? await resolveUserName(lookupWeb, msg.user)
        : "Unknown";
      result.push({
        author: authorName,
        text: cleanText(msg.text || ""),
        ts: msg.ts || "",
        isParent: msg.ts === messageTs,
      });
    }

    return result;
  } catch {
    // Thread may not exist (no replies), or channel access denied — degrade silently
    return [];
  }
}

/**
 * Format a thread into a plain-text transcript for AI input.
 *
 * Output format:
 *   Channel: #eng-team
 *
 *   Alice: We need to decide on the API approach.
 *   Bob: I think REST is safer for now.
 *   Alice: Agreed — let's go with REST. @Michael can you update the spec?
 */
export function formatThreadTranscript(
  messages: SlackThreadMessage[],
  channelName: string
): string {
  if (messages.length === 0) return "";

  const lines = messages.map((m) => `${m.author}: ${m.text}`);
  const full = `Channel: ${channelName}\n\n${lines.join("\n")}`;
  return full.slice(0, MAX_TRANSCRIPT_CHARS);
}
