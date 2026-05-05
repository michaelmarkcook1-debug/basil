/**
 * Fetch a Teams thread (parent message + all replies) as a normalized
 * plain-text transcript for AI classification.
 *
 * Mirrors the shape and behaviour of lib/slack/fetch-thread.ts — same
 * interface field names, same formatTranscript output format, same
 * cost-control caps, same "never throws" contract.
 *
 * Cost controls:
 * - Cap: 20 replies per thread.
 * - Per-message text: 500 chars.
 * - Total transcript: capped to 6 000 chars before passing to the AI.
 */

import { graphGet } from "@/lib/microsoft/auth";

const MAX_THREAD_REPLIES  = 20;
const MAX_CHARS_PER_MSG   = 500;
const MAX_TRANSCRIPT_CHARS = 6_000;

// ── Types ────────────────────────────────────────────────────────────────────

export interface TeamsThreadMessage {
  author:  string;
  text:    string;
  date:    string;
  isReply: boolean;
}

// ── Graph response shapes (internal) ─────────────────────────────────────────

interface GraphMessageBody {
  content:     string;
  contentType: string; // "text" | "html"
}

interface GraphChatMessage {
  id:              string;
  createdDateTime: string;
  from?:           { user?: { displayName?: string } };
  body:            GraphMessageBody;
  messageType:     string;
}

interface GraphListResponse<T> {
  value: T[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g,    " ")
    .trim();
}

function cleanText(msg: GraphChatMessage): string {
  const raw = msg.body?.contentType === "html"
    ? stripHtml(msg.body.content || "")
    : (msg.body?.content || "").trim();
  return raw.slice(0, MAX_CHARS_PER_MSG);
}

function mapMessage(msg: GraphChatMessage, isReply: boolean): TeamsThreadMessage {
  return {
    author:  msg.from?.user?.displayName || "Unknown",
    text:    cleanText(msg),
    date:    msg.createdDateTime,
    isReply,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch all messages in a Teams thread (parent + replies).
 *
 * - If channelId is null: treated as a chat message →
 *   GET /me/chats/{chatOrTeamId}/messages/{messageId}/replies
 * - If channelId is set: treated as a team channel message →
 *   GET /teams/{chatOrTeamId}/channels/{channelId}/messages/{messageId}/replies
 *
 * The parent message is fetched separately and prepended.
 * Returns empty array on any failure — never throws.
 */
export async function fetchTeamsThread(
  username:     string,
  chatOrTeamId: string,
  channelId:    string | null,
  messageId:    string
): Promise<TeamsThreadMessage[]> {
  try {
    const isChannel = channelId !== null;

    const parentPath = isChannel
      ? `/teams/${chatOrTeamId}/channels/${channelId}/messages/${messageId}`
      : `/me/chats/${chatOrTeamId}/messages/${messageId}`;

    const repliesPath = isChannel
      ? `/teams/${chatOrTeamId}/channels/${channelId}/messages/${messageId}/replies?$top=${MAX_THREAD_REPLIES}`
      : `/me/chats/${chatOrTeamId}/messages/${messageId}/replies?$top=${MAX_THREAD_REPLIES}`;

    const [parentData, repliesData] = await Promise.all([
      graphGet<GraphChatMessage>(username, parentPath).catch(() => null), // ci-ok: partial Teams thread data is acceptable; null handled in caller
      graphGet<GraphListResponse<GraphChatMessage>>(username, repliesPath).catch(() => null), // ci-ok: partial Teams thread data is acceptable; null handled in caller
    ]);

    const result: TeamsThreadMessage[] = [];

    if (parentData && parentData.messageType === "message") {
      result.push(mapMessage(parentData, false));
    }

    if (repliesData?.value) {
      for (const reply of repliesData.value.slice(0, MAX_THREAD_REPLIES)) {
        if (reply.messageType !== "message") continue;
        if (!reply.body?.content?.trim()) continue;
        result.push(mapMessage(reply, true));
      }
    }

    // Sort chronologically
    return result.sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    // Thread may not exist or access denied — degrade silently
    return [];
  }
}

/**
 * Format a Teams thread into a plain-text transcript for AI input.
 *
 * Output format:
 *   Channel: Team > General
 *
 *   [2025-04-23T09:00:00.000Z] Alice: We need to decide on the approach.
 *   [2025-04-23T09:05:00.000Z] Bob: I think Option A is safer.
 */
export function formatTeamsTranscript(
  messages:    TeamsThreadMessage[],
  channelName: string
): string {
  if (messages.length === 0) return "";

  const lines = messages.map((m) => `[${m.date}] ${m.author}: ${m.text}`);
  const full  = `Channel: ${channelName}\n\n${lines.join("\n")}`;
  return full.slice(0, MAX_TRANSCRIPT_CHARS);
}
