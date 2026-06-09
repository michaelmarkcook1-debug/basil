/**
 * Microsoft Teams message fetching via Microsoft Graph API.
 *
 * Mirrors the shape and behaviour of lib/slack/client.ts — same interface
 * field names, same fetch-then-merge-and-sort pattern, same error-handling
 * conventions.  Uses raw fetch via graphGet/graphFetch (no external SDK).
 */

import { graphGet, graphFetch } from "@/lib/microsoft/auth";
import { getSelfIdentity, isSelf, type SelfIdentity } from "@/lib/self-identity";

// ── Types ────────────────────────────────────────────────────────────────────

export interface TeamsMessage {
  id:               string;  // message id
  chatOrChannelId:  string;  // parent chat/channel id
  channelId?:       string;  // if from a team channel
  teamId?:          string;  // if from a team channel
  channel:          string;  // display name: "DM: Name", "#channel-name", "Team > Channel"
  author:           string;  // display name
  text:             string;  // plaintext (HTML stripped)
  date:             string;  // ISO
  isMention:        boolean; // body @-mentions the current user (by resolved self-identity)
  isDM:             boolean; // source is a chat (not a team channel)
}

// ── Graph response shapes (internal) ─────────────────────────────────────────

interface GraphChat {
  id:                   string;
  chatType:             string; // "oneOnOne" | "group" | "meeting"
  lastMessagePreview?:  { createdDateTime?: string };
  topic?:               string;
}

interface GraphChatMember {
  displayName: string;
  userId?:     string;
}

interface GraphMessageBody {
  content:     string;
  contentType: string;  // "text" | "html"
}

interface GraphChatMessage {
  id:              string;
  createdDateTime: string;
  from?:           { user?: { displayName?: string } };
  body:            GraphMessageBody;
  messageType:     string; // "message" | "systemEventMessage" | etc.
}

interface GraphTeam {
  id:          string;
  displayName: string;
}

interface GraphChannel {
  id:          string;
  displayName: string;
}

interface GraphListResponse<T> {
  value: T[];
}

interface GraphSearchHit {
  resource: {
    id:               string;
    createdDateTime:  string;
    from?:            { user?: { displayName?: string } };
    body?:            GraphMessageBody;
    channelIdentity?: { channelId?: string; teamId?: string };
    chatId?:          string;
  };
}

interface GraphSearchResponse {
  value: Array<{
    hitsContainers?: Array<{
      hits?: GraphSearchHit[];
    }>;
  }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strip HTML tags from Graph message body content. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g,   "&")
    .replace(/&lt;/g,    "<")
    .replace(/&gt;/g,    ">")
    .replace(/&nbsp;/g,  " ")
    .replace(/\s+/g,     " ")
    .trim()
    .slice(0, 500);
}

function isMention(text: string, identity: SelfIdentity): boolean {
  const lower = text.toLowerCase();
  return identity.names.some((n) => {
    if (!n) return false;
    const nm = n.toLowerCase();
    const handle = "@" + nm.replace(/\s+/g, "");
    const dotted = "@" + nm.replace(/\s+/g, ".");
    const first  = "@" + nm.split(/\s+/)[0];
    return lower.includes(handle) || lower.includes(dotted) || lower.includes(first);
  });
}

function mapChatMessage(
  msg:             GraphChatMessage,
  chatOrChannelId: string,
  channelName:     string,
  isDM:            boolean,
  identity:        SelfIdentity,
  channelId?:      string,
  teamId?:         string
): TeamsMessage {
  const rawText = msg.body?.contentType === "html"
    ? stripHtml(msg.body.content || "")
    : (msg.body?.content || "").slice(0, 500);

  return {
    id:              msg.id,
    chatOrChannelId,
    channelId,
    teamId,
    channel:         channelName,
    author:          msg.from?.user?.displayName || "Unknown",
    text:            rawText,
    date:            msg.createdDateTime,
    isMention:       isMention(rawText, identity),
    isDM,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch recent messages from both DM/group chats and joined team channels.
 * Returns the most recent `limit` messages within `maxAgeDays`.
 * Never throws — returns empty array on any failure.
 */
export async function getRecentTeamsMessages(
  username:   string,
  limit      = 30,
  maxAgeDays = 3
): Promise<TeamsMessage[]> {
  const cutoff = new Date(Date.now() - maxAgeDays * 86400000).toISOString();
  const messages: TeamsMessage[] = [];
  const selfIdentity = await getSelfIdentity(username).catch(() => ({ emails: [], names: [] }));

  // ── 1. Chats (DMs and group chats) ───────────────────────────────────────

  try {
    const chatsData = await graphGet<GraphListResponse<GraphChat>>(
      username,
      "/me/chats?$top=20&$expand=lastMessagePreview"
    );

    if (chatsData?.value) {
      // Sort chats by last activity so we fetch the most active ones first
      const sortedChats = [...chatsData.value].sort((a, b) => {
        const aTime = a.lastMessagePreview?.createdDateTime || "";
        const bTime = b.lastMessagePreview?.createdDateTime || "";
        return bTime.localeCompare(aTime);
      });

      for (const chat of sortedChats.slice(0, 20)) {
        try {
          const msgsData = await graphGet<GraphListResponse<GraphChatMessage>>(
            username,
            `/me/chats/${chat.id}/messages?$top=10`
          );

          if (!msgsData?.value) continue;

          // Resolve chat display name
          let channelName = chat.topic || "Chat";
          const isOneOnOne = chat.chatType === "oneOnOne";

          if (isOneOnOne) {
            try {
              const membersData = await graphGet<GraphListResponse<GraphChatMember>>(
                username,
                `/me/chats/${chat.id}/members`
              );
              const others = (membersData?.value || []).filter(
                (m) => !isSelf(m.displayName ?? "", selfIdentity)
              );
              if (others.length > 0) channelName = `DM: ${others[0].displayName}`;
            } catch {
              channelName = "DM";
            }
          }

          for (const msg of msgsData.value) {
            if (msg.messageType !== "message") continue;
            if (!msg.body?.content?.trim()) continue;
            if (msg.createdDateTime < cutoff) continue;

            messages.push(
              mapChatMessage(msg, chat.id, channelName, true, selfIdentity)
            );
          }
        } catch {
          /* skip inaccessible chats */
        }
      }
    }
  } catch (err) {
    console.error("[teams-client] Chat fetch error:", err instanceof Error ? err.message : err);
  }

  // ── 2. Team channels ──────────────────────────────────────────────────────

  try {
    const teamsData = await graphGet<GraphListResponse<GraphTeam>>(
      username,
      "/me/joinedTeams?$top=10"
    );

    if (teamsData?.value) {
      for (const team of teamsData.value) {
        try {
          const channelsData = await graphGet<GraphListResponse<GraphChannel>>(
            username,
            `/teams/${team.id}/channels?$top=10`
          );

          if (!channelsData?.value) continue;

          for (const channel of channelsData.value) {
            try {
              const msgsData = await graphGet<GraphListResponse<GraphChatMessage>>(
                username,
                `/teams/${team.id}/channels/${channel.id}/messages?$top=10`
              );

              if (!msgsData?.value) continue;

              const channelName = `${team.displayName} > ${channel.displayName}`;

              for (const msg of msgsData.value) {
                if (msg.messageType !== "message") continue;
                if (!msg.body?.content?.trim()) continue;
                if (msg.createdDateTime < cutoff) continue;

                messages.push(
                  mapChatMessage(
                    msg,
                    channel.id,
                    channelName,
                    false,
                    selfIdentity,
                    channel.id,
                    team.id
                  )
                );
              }
            } catch {
              /* skip inaccessible channels */
            }
          }
        } catch {
          /* skip inaccessible teams */
        }
      }
    }
  } catch (err) {
    console.error("[teams-client] Joined teams fetch error:", err instanceof Error ? err.message : err);
  }

  // ── Sort and cap ──────────────────────────────────────────────────────────

  return messages
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit);
}

/**
 * Search Teams/chat messages using Graph Search API.
 * Returns up to `limit` messages matching the query.
 * Never throws — returns empty array on any failure.
 */
export async function searchTeamsMessages(
  username: string,
  query:    string,
  limit =   10
): Promise<TeamsMessage[]> {
  const selfIdentity = await getSelfIdentity(username).catch(() => ({ emails: [], names: [] }));
  try {
    const res = await graphFetch(username, "https://graph.microsoft.com/v1.0/search/query", {
      method: "POST",
      body:   JSON.stringify({
        requests: [
          {
            entityTypes: ["chatMessage"],
            query:       { queryString: query },
            from:        0,
            size:        limit,
          },
        ],
      }),
    });

    if (!res) return [];
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[teams-client] searchTeamsMessages HTTP ${res.status}: ${text.slice(0, 200)}`);
      return [];
    }

    const data = await res.json() as GraphSearchResponse;
    const hits  = data?.value?.[0]?.hitsContainers?.[0]?.hits || [];

    return hits.map((hit): TeamsMessage => {
      const r        = hit.resource;
      const body     = r.body?.contentType === "html"
        ? stripHtml(r.body?.content || "")
        : (r.body?.content || "").slice(0, 500);
      const isDM     = !!r.chatId && !r.channelIdentity?.channelId;
      const chatOrChannelId = r.channelIdentity?.channelId || r.chatId || r.id;

      return {
        id:              r.id,
        chatOrChannelId,
        channelId:       r.channelIdentity?.channelId,
        teamId:          r.channelIdentity?.teamId,
        channel:         isDM ? "DM" : "Channel",
        author:          r.from?.user?.displayName || "Unknown",
        text:            body,
        date:            r.createdDateTime,
        isMention:       isMention(body, selfIdentity),
        isDM,
      };
    });
  } catch (err) {
    console.error("[teams-client] searchTeamsMessages error:", err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Send a message to a Teams chat.
 */
export async function sendTeamsMessage(
  username: string,
  chatId:   string,
  text:     string
): Promise<{ id: string }> {
  const res = await graphFetch(username, `/me/chats/${chatId}/messages`, {
    method: "POST",
    body:   JSON.stringify({ body: { content: text } }),
  });

  if (!res) throw new Error("Microsoft not connected");
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`sendTeamsMessage HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json() as { id: string };
  return { id: data.id };
}

/**
 * Get the display names of all members in a Teams chat.
 */
export async function getTeamsChatMembers(
  username: string,
  chatId:   string
): Promise<string[]> {
  try {
    const data = await graphGet<GraphListResponse<GraphChatMember>>(
      username,
      `/me/chats/${chatId}/members`
    );
    return (data?.value || [])
      .map((m) => m.displayName)
      .filter(Boolean) as string[];
  } catch (err) {
    console.error("[teams-client] getTeamsChatMembers error:", err instanceof Error ? err.message : err);
    return [];
  }
}
