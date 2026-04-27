/**
 * Microsoft Teams signal via Graph API.
 *
 * Provides two families of data:
 *
 *  1. Chat messages — direct chats + group chats with a contact, used for
 *     personality profiling (equivalent to Slack signal).
 *
 *  2. Teams meetings — Outlook Calendar events that are online (Teams) meetings,
 *     used for meeting prep and digest (equivalent to Zoom summaries).
 *
 * Required scopes:
 *   Chat.Read / Chat.ReadBasic  — for chat messages
 *   Team.ReadBasic.All          — for joined team list
 *   Channel.ReadBasic.All       — for channel listing
 *   Calendars.ReadWrite         — for meeting history (already granted)
 *
 * All functions return empty arrays/null when the token lacks the required
 * scope — callers must not crash on a scope-missing 403.
 */

import { graphGet } from "./auth";
import { getOutlookPastMeetings } from "./outlook-calendar";

// ── Graph types ───────────────────────────────────────────────────────────────

interface GraphChat {
  id:        string;
  chatType:  "oneOnOne" | "group" | "meeting" | "unknownFutureValue";
  topic?:    string;
  members?:  GraphChatMember[];
}

interface GraphChatMember {
  id:          string;
  displayName: string;
  email?:      string;
}

interface GraphChatMessage {
  id:              string;
  createdDateTime: string;
  from?: {
    user?: { displayName: string; id?: string };
    application?: { displayName: string };
  };
  body: { content: string; contentType: "text" | "html" };
  messageType: string;
}

interface GraphTeam {
  id:          string;
  displayName: string;
}

interface GraphChannel {
  id:          string;
  displayName: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatMessage(
  msg: GraphChatMessage,
  contextName: string
): string | null {
  if (msg.messageType !== "message") return null;
  const text =
    msg.body.contentType === "html"
      ? stripHtml(msg.body.content)
      : msg.body.content.trim();
  if (!text || text.length < 3) return null;
  const author = msg.from?.user?.displayName ?? msg.from?.application?.displayName ?? "Unknown";
  const date   = msg.createdDateTime.slice(0, 10);
  return `[${date}] ${author} in ${contextName}: ${text.slice(0, 300)}`;
}

// ── Public: chat messages for a contact ──────────────────────────────────────

export interface TeamsChatMessage {
  id:      string;
  date:    string;
  author:  string;
  channel: string;
  text:    string;
}

/**
 * Returns formatted message lines for a contact — direct chats and group
 * chats where the contact is a member. Used in contact profiling.
 */
export async function getTeamsChatSignalForContact(
  username: string,
  name:     string,
  limit =   40
): Promise<string[]> {
  const nameLower = name.trim().toLowerCase();
  const firstName = nameLower.split(/\s+/)[0];

  // Step 1 — list all chats with members expanded
  let chats: GraphChat[] = [];
  try {
    const res = await graphGet<{ value: GraphChat[] }>(
      username,
      "/me/chats?$expand=members&$top=50"
    );
    chats = res?.value ?? [];
  } catch (err) {
    // 403 = Chat.Read not granted yet — fail silently
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("403") || msg.includes("Forbidden") || msg.includes("Authorization")) {
      return [];
    }
    console.error("[teams] Failed to list chats:", msg);
    return [];
  }

  // Step 2 — find chats involving the contact
  const matchingChats = chats.filter((chat) =>
    chat.members?.some((m) => {
      const dn = m.displayName?.toLowerCase() ?? "";
      return (
        dn.includes(nameLower) ||
        (firstName.length >= 3 && dn.includes(firstName)) ||
        (m.email && m.email.toLowerCase().includes(nameLower))
      );
    })
  );

  if (matchingChats.length === 0) return [];

  // Step 3 — fetch messages from matching chats
  const lines: string[] = [];
  for (const chat of matchingChats.slice(0, 5)) {
    const label =
      chat.topic ||
      (chat.chatType === "oneOnOne" ? "Direct message" : "Group chat");

    try {
      const msgRes = await graphGet<{ value: GraphChatMessage[] }>(
        username,
        `/me/chats/${chat.id}/messages?$top=30&$orderby=createdDateTime desc`
      );
      for (const m of msgRes?.value ?? []) {
        const line = formatMessage(m, `Teams/${label}`);
        if (line) lines.push(line);
        if (lines.length >= limit) break;
      }
    } catch {
      // Skip inaccessible chats
    }
    if (lines.length >= limit) break;
  }

  return lines;
}

/**
 * Returns recent Teams channel messages mentioning the contact's name.
 * Falls back to empty if Team.ReadBasic.All or ChannelMessage.Read.All
 * scopes are not granted.
 */
export async function getTeamsChannelSignalForContact(
  username: string,
  name:     string,
  limit =   20
): Promise<string[]> {
  const nameLower = name.trim().toLowerCase();
  const firstName = nameLower.split(/\s+/)[0];
  const lines: string[] = [];

  let teams: GraphTeam[] = [];
  try {
    const res = await graphGet<{ value: GraphTeam[] }>(username, "/me/joinedTeams?$top=20");
    teams = res?.value ?? [];
  } catch {
    return []; // scope not granted
  }

  for (const team of teams.slice(0, 5)) {
    let channels: GraphChannel[] = [];
    try {
      const res = await graphGet<{ value: GraphChannel[] }>(
        username,
        `/teams/${team.id}/channels?$top=20`
      );
      channels = res?.value ?? [];
    } catch {
      continue;
    }

    for (const channel of channels.slice(0, 3)) {
      try {
        const res = await graphGet<{ value: GraphChatMessage[] }>(
          username,
          `/teams/${team.id}/channels/${channel.id}/messages?$top=50`
        );
        for (const m of res?.value ?? []) {
          if (m.messageType !== "message") continue;
          const text =
            m.body.contentType === "html"
              ? stripHtml(m.body.content)
              : m.body.content.trim();
          if (!text) continue;

          const textLower  = text.toLowerCase();
          const authorName = m.from?.user?.displayName?.toLowerCase() ?? "";
          const hit =
            authorName.includes(nameLower) ||
            textLower.includes(nameLower) ||
            (firstName.length >= 3 &&
              (authorName.includes(firstName) || textLower.includes(firstName)));
          if (!hit) continue;

          const label = `Teams/${team.displayName}/${channel.displayName}`;
          const line  = formatMessage(m, label);
          if (line) lines.push(line);
          if (lines.length >= limit) return lines;
        }
      } catch {
        continue;
      }
    }
    if (lines.length >= limit) break;
  }

  return lines;
}

// ── Public: Teams meetings (equivalent to Zoom summaries) ────────────────────

export interface TeamsMeeting {
  /** "teams" */
  source: "teams";
  title:  string;
  date:   string;
  body:   string;
  attendees: string[];
}

/**
 * Returns recent Teams online meeting events from Outlook Calendar.
 * Uses the already-granted Calendars.ReadWrite scope — no extra scopes needed.
 * This is the equivalent of getZoomSummaries() for Microsoft users.
 */
export async function getTeamsMeetings(username: string, daysBack = 30): Promise<TeamsMeeting[]> {
  try {
    const events = await getOutlookPastMeetings(username, daysBack);
    return events.map((e) => ({
      source:    "teams" as const,
      title:     e.summary,
      date:      e.start.slice(0, 10),
      attendees: e.attendees,
      body: [
        `Attendees: ${e.attendees.join(", ") || "none listed"}`,
        `Duration: ${
          Math.round(
            (new Date(e.end).getTime() - new Date(e.start).getTime()) / 60_000
          )
        } min`,
      ].join("\n"),
    }));
  } catch (err) {
    console.error("[teams] Failed to fetch Teams meetings:", err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Filters a TeamsMeeting array to those where an attendee's display name
 * contains one of the provided names — mirrors filterByAttendees() from
 * zoom-summaries.ts for drop-in replacement.
 */
export function filterTeamsMeetingsByAttendees(
  meetings: TeamsMeeting[],
  names: string[]
): TeamsMeeting[] {
  const needles = names.map((n) => n.toLowerCase());
  return meetings.filter((m) =>
    m.attendees.some((a) =>
      needles.some((n) => a.toLowerCase().includes(n))
    )
  );
}
