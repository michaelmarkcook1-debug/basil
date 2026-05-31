/**
 * Durable Zoom meeting ingest workflow.
 *
 * Triggered by the Zoom Events API webhook when a meeting ends or a recording
 * becomes available. Fetches meeting details, participants, and transcript from
 * the Zoom API, then runs processZoomMeeting to extract actions, decisions,
 * and memories.
 *
 * FatalError → do not retry (e.g. meeting not found, permanent auth failure)
 * Any other thrown error → retry automatically
 */
import { FatalError } from "workflow";
import type { IngestZoomPayload } from "../types";

// ── Step: process a single Zoom meeting ───────────────────────────────────────

async function processZoomMeetingStep(username: string, payload: IngestZoomPayload): Promise<void> {
  "use step";

  const { meetingId, externalId, eventId } = payload;

  console.log(`[ingest-zoom] step start: meetingId=${meetingId} externalId=${externalId} username=${username}`);

  const { hasExternalId, createEvent } = await import("@/lib/events/store");
  const { eventFromIngest } = await import("@/lib/events/rules");
  const { publish } = await import("@/lib/events/bus");
  const { getMeetingParticipants, getRecentRecordingsWithTranscripts } = await import("@/lib/zoom/client");
  const { processZoomMeeting } = await import("@/lib/zoom/process-meeting");
  const { getValidZoomAccessToken } = await import("@/lib/zoom/auth");

  // Verify Zoom is still connected for this user
  const token = await getValidZoomAccessToken(username);
  if (!token) throw new FatalError(`[ingest-zoom] Zoom not connected for ${username}`);

  // Fetch meeting details via Zoom REST API directly (meeting ID is numeric)
  const meetingRes = await fetch(`https://api.zoom.us/v2/meetings/${encodeURIComponent(meetingId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  let meetingObj: {
    id?: number | string;
    uuid?: string;
    topic?: string;
    start_time?: string;
    duration?: number;
    host_id?: string;
    host_email?: string;
  } | null = null;

  if (meetingRes.ok) {
    meetingObj = await meetingRes.json() as typeof meetingObj;
  } else if (meetingRes.status === 404) {
    // Meeting may have ended and been moved to reports — try the past meetings report
    const from = new Date(Date.now() - 86400_000).toISOString().split("T")[0];
    const reportRes = await fetch(
      `https://api.zoom.us/v2/report/users/me/meetings?from=${from}&type=past&page_size=100`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (reportRes.ok) {
      const data = await reportRes.json() as { meetings?: Array<{ id?: number | string; uuid?: string; topic?: string; start_time?: string; duration?: number; host_id?: string; host_email?: string }> };
      meetingObj = data.meetings?.find((m) => String(m.id) === String(meetingId)) ?? null;
    }
  }

  if (!meetingObj) {
    console.warn(`[ingest-zoom] meeting ${meetingId} not found in API — skipping`);
    return;
  }

  const meeting = {
    id:               String(meetingObj.id ?? meetingId),
    uuid:             meetingObj.uuid ?? meetingId,
    topic:            meetingObj.topic ?? "Zoom Meeting",
    startTime:        meetingObj.start_time ?? new Date().toISOString(),
    duration:         meetingObj.duration ?? 0,
    hostId:           meetingObj.host_id ?? "",
    hostEmail:        meetingObj.host_email,
    type:             2,
  };

  // Create a BasilEvent if one wasn't already created
  let resolvedEventId = eventId;
  if (!resolvedEventId || !(await hasExternalId(username, externalId))) {
    const shaped = eventFromIngest({
      source: "zoom",
      externalId,
      title: meeting.topic,
      body: `Zoom meeting ended: ${meeting.topic} (${meeting.duration} min)`,
    });
    const event = await createEvent(username, shaped);
    publish(event);
    resolvedEventId = event.id;
  }

  // Fetch participants and recent recordings (last 1 day) for transcript
  const [participants, recordings] = await Promise.all([
    getMeetingParticipants(username, meeting.uuid).catch(() => []),
    getRecentRecordingsWithTranscripts(username, 2).catch(() => []),
  ]);

  const recording = recordings.find((r) => String(r.meetingId) === String(meetingId));

  await processZoomMeeting({
    username,
    meeting,
    participants: participants.length > 0 ? participants : undefined,
    recording,
    eventId: resolvedEventId,
  });

  console.log(`[ingest-zoom] step complete: meetingId=${meetingId} participants=${participants.length} hasTranscript=${!!recording?.transcript}`);
}

// ── Workflow ───────────────────────────────────────────────────────────────────

export async function ingestZoomWorkflow(
  username: string,
  payload: IngestZoomPayload
): Promise<void> {
  "use workflow";

  try {
    await processZoomMeetingStep(username, payload);
  } catch (err) {
    if (err instanceof FatalError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[ingest-zoom] Failed to process meeting ${payload.meetingId}: ${msg}`);
  }
}
