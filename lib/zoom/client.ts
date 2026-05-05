/**
 * Zoom REST API v2 client.
 *
 * Provides typed wrappers over the endpoints relevant to Basil:
 *   - Past meetings list (with pagination)
 *   - Meeting details (host, duration, start time)
 *   - Meeting participants
 *   - Cloud recording transcripts
 *
 * All functions return empty results silently when Zoom is not connected,
 * so callers never need to check connection state first.
 *
 * Required env vars (set by the Zoom OAuth flow):
 *   ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET
 *
 * Tokens are stored per-user via zoom/auth.ts and auto-refreshed on 401.
 */

import { getValidZoomAccessToken, refreshZoomTokens } from "./auth";

const ZOOM_API = "https://api.zoom.us/v2";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ZoomMeeting {
  id: string;             // numeric meeting ID (as string to avoid BigInt issues)
  uuid: string;           // unique instance UUID (changes per occurrence)
  topic: string;
  startTime: string;      // ISO 8601
  duration: number;       // minutes
  hostId: string;
  hostEmail?: string;
  totalMinutes?: number;
  participantCount?: number;
  type: number;           // 1=instant, 2=scheduled, 3=recurring, 8=recurring+fixed
}

export interface ZoomParticipant {
  name: string;
  email?: string;
  joinTime?: string;
  leaveTime?: string;
  duration?: number;      // seconds in meeting
}

export interface ZoomRecording {
  meetingId: string;
  topic: string;
  startTime: string;
  duration: number;
  /** Plain-text transcript, if a cloud recording with audio transcript exists. */
  transcript?: string;
  /** Summary from Zoom AI Companion, if available. */
  summary?: string;
  /** VTT transcript file download URL (requires bearer auth). */
  transcriptDownloadUrl?: string;
  playUrl?: string;
}

// ── Low-level fetch ───────────────────────────────────────────────────────────

/**
 * Make an authenticated GET/POST against the Zoom API.
 * Handles 401 by attempting one token refresh and retrying.
 */
async function zoomFetch(
  username: string,
  path: string,
  options: RequestInit = {}
): Promise<Response | null> {
  let token = await getValidZoomAccessToken(username);
  if (!token) return null;

  const url = path.startsWith("https://") ? path : `${ZOOM_API}${path}`;

  const makeHeaders = (t: string) => ({
    Authorization: `Bearer ${t}`,
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) ?? {}),
  });

  let res = await fetch(url, { ...options, headers: makeHeaders(token) });

  if (res.status === 401) {
    // Token may have been invalidated server-side — force refresh and retry once
    const refreshed = await refreshZoomTokens(username);
    if (!refreshed?.access_token) return res;
    token = refreshed.access_token;
    res = await fetch(url, { ...options, headers: makeHeaders(token) });
  }

  return res;
}

async function zoomGet<T>(username: string, path: string): Promise<T | null> {
  const res = await zoomFetch(username, path);
  if (!res) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // 404 = meeting no longer exists (deleted/purged), not an error worth logging loudly
    if (res.status !== 404) {
      console.warn(`[zoom-client] GET ${path} → ${res.status}: ${body.slice(0, 200)}`);
    }
    return null;
  }
  return res.json() as Promise<T>;
}

// ── Past meetings ─────────────────────────────────────────────────────────────

/**
 * Fetch the list of past Zoom meetings for the authenticated user.
 *
 * @param username       Basil user whose Zoom token to use.
 * @param sinceDaysAgo   How far back to look (default: 30 days).
 * @param maxResults     Cap on total results returned (default: 50).
 */
export async function getPastMeetings(
  username: string,
  sinceDaysAgo = 30,
  maxResults = 50
): Promise<ZoomMeeting[]> {
  try {
    const from = new Date(Date.now() - sinceDaysAgo * 86400000)
      .toISOString()
      .split("T")[0]; // YYYY-MM-DD

    // Zoom's report endpoint gives richer data (participant counts, duration)
    // than the basic meetings list.
    const data = await zoomGet<{
      meetings?: Array<{
        id: number;
        uuid: string;
        topic: string;
        start_time: string;
        duration: number;
        host_id: string;
        host_email?: string;
        total_minutes?: number;
        participants_count?: number;
        type?: number;
      }>;
    }>(
      username,
      `/report/users/me/meetings?from=${from}&type=past&page_size=${Math.min(maxResults, 300)}`
    );

    return (data?.meetings ?? []).slice(0, maxResults).map((m) => ({
      id:               String(m.id),
      uuid:             m.uuid,
      topic:            m.topic,
      startTime:        m.start_time,
      duration:         m.duration,
      hostId:           m.host_id,
      hostEmail:        m.host_email,
      totalMinutes:     m.total_minutes,
      participantCount: m.participants_count,
      type:             m.type ?? 2,
    }));
  } catch (err) {
    console.error("[zoom-client] getPastMeetings failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

// ── Meeting participants ──────────────────────────────────────────────────────

/**
 * Fetch the participant list for a specific past meeting instance.
 *
 * @param meetingUuid  The meeting UUID (unique per occurrence, NOT the meeting ID).
 *                     Double-encode if it contains "/" or "+" (Zoom requirement).
 */
export async function getMeetingParticipants(
  username: string,
  meetingUuid: string
): Promise<ZoomParticipant[]> {
  try {
    // Zoom requires double-URL-encoding UUIDs that contain "/" or "+"
    const encoded = meetingUuid.includes("/") || meetingUuid.includes("+")
      ? encodeURIComponent(encodeURIComponent(meetingUuid))
      : encodeURIComponent(meetingUuid);

    const data = await zoomGet<{
      participants?: Array<{
        name: string;
        user_email?: string;
        join_time?: string;
        leave_time?: string;
        duration?: number;
      }>;
    }>(username, `/report/meetings/${encoded}/participants?page_size=100`);

    return (data?.participants ?? []).map((p) => ({
      name:      p.name,
      email:     p.user_email || undefined,
      joinTime:  p.join_time  || undefined,
      leaveTime: p.leave_time || undefined,
      duration:  p.duration   || undefined,
    }));
  } catch (err) {
    console.error("[zoom-client] getMeetingParticipants failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

// ── Cloud recordings & transcripts ────────────────────────────────────────────

/**
 * List cloud recordings for the user and download any available transcripts.
 *
 * Zoom AI Companion transcripts are stored as VTT recording files with
 * `recording_type: "audio_transcript"`. We download and convert them to
 * plain text for classification.
 *
 * @param sinceDaysAgo  How far back to look (default: 30 days).
 * @param maxMeetings   Cap on how many meetings to retrieve recordings for.
 */
export async function getRecentRecordingsWithTranscripts(
  username: string,
  sinceDaysAgo = 30,
  maxMeetings = 20
): Promise<ZoomRecording[]> {
  try {
    const from = new Date(Date.now() - sinceDaysAgo * 86400000)
      .toISOString()
      .split("T")[0];

    const data = await zoomGet<{
      meetings?: Array<{
        id: number;
        uuid: string;
        topic: string;
        start_time: string;
        duration: number;
        recording_files?: Array<{
          recording_type: string;
          download_url: string;
          status: string;
        }>;
      }>;
    }>(username, `/users/me/recordings?from=${from}&page_size=${Math.min(maxMeetings, 100)}`);

    const results: ZoomRecording[] = [];

    for (const meeting of (data?.meetings ?? []).slice(0, maxMeetings)) {
      const transcriptFile = meeting.recording_files?.find(
        (f) =>
          f.recording_type === "audio_transcript" &&
          f.status === "completed" &&
          f.download_url
      );

      let transcript: string | undefined;
      if (transcriptFile?.download_url) {
        try {
          const token = await getValidZoomAccessToken(username);
          if (token) {
            const vttRes = await fetch(
              `${transcriptFile.download_url}?access_token=${token}`
            );
            if (vttRes.ok) {
              const vttText = await vttRes.text();
              transcript = vttToPlainText(vttText);
            }
          }
        } catch (e) {
          console.warn("[zoom-client] transcript download failed for", meeting.uuid, e);
        }
      }

      results.push({
        meetingId: String(meeting.id),
        topic:     meeting.topic,
        startTime: meeting.start_time,
        duration:  meeting.duration,
        transcript,
        playUrl:   undefined,
      });
    }

    return results;
  } catch (err) {
    console.error("[zoom-client] getRecentRecordingsWithTranscripts failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

// ── Upcoming meetings ─────────────────────────────────────────────────────────

/**
 * Fetch upcoming scheduled meetings (for briefings and meeting prep).
 */
export async function getUpcomingMeetings(
  username: string,
  maxResults = 10
): Promise<ZoomMeeting[]> {
  try {
    const data = await zoomGet<{
      meetings?: Array<{
        id: number;
        uuid: string;
        topic: string;
        start_time: string;
        duration: number;
        host_id: string;
        type?: number;
      }>;
    }>(username, `/users/me/meetings?type=scheduled&page_size=${Math.min(maxResults, 100)}`);

    return (data?.meetings ?? []).slice(0, maxResults).map((m) => ({
      id:       String(m.id),
      uuid:     m.uuid,
      topic:    m.topic,
      startTime: m.start_time,
      duration:  m.duration,
      hostId:    m.host_id,
      type:      m.type ?? 2,
    }));
  } catch (err) {
    console.error("[zoom-client] getUpcomingMeetings failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Convert a Zoom VTT transcript file to plain readable text.
 * Strips cue headers and timing lines; joins speaker+text pairs.
 *
 * Example VTT input:
 *   WEBVTT
 *   00:00:01.000 --> 00:00:04.000
 *   John Smith: Hello everyone.
 */
function vttToPlainText(vtt: string): string {
  return vtt
    .split("\n")
    .filter((line) => {
      if (!line.trim()) return false;
      if (line.startsWith("WEBVTT")) return false;
      if (line.startsWith("NOTE")) return false;
      // Skip timing lines (00:00:01.000 --> 00:00:04.000)
      if (/^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+/.test(line)) return false;
      // Skip standalone numeric cue IDs
      if (/^\d+$/.test(line.trim())) return false;
      return true;
    })
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 8000); // cap at 8k chars for AI input
}
