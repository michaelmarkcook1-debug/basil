import { NextResponse } from "next/server";
import { isGoogleConnected, getAuthedClient } from "@/lib/google/auth";
import { getSessionUser } from "@/lib/auth";
import { google } from "googleapis";
import { emitAuditEvent } from "@/lib/events/audit";

type RSVPStatus = "accepted" | "declined" | "tentative";

/**
 * POST /api/calendar/[eventId]/rsvp
 * Body: { status: "accepted" | "declined" | "tentative" }
 *
 * Updates the authenticated user's response status on a calendar event invite.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ eventId: string }> }
) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  if (!(await isGoogleConnected(username))) {
    return NextResponse.json({ error: "Google Calendar not connected." }, { status: 401 });
  }

  const { eventId } = await params;
  if (!eventId) return NextResponse.json({ error: "Missing eventId" }, { status: 400 });

  let status: RSVPStatus;
  try {
    const body = await req.json();
    if (!["accepted", "declined", "tentative"].includes(body.status)) {
      return NextResponse.json({ error: "status must be accepted, declined, or tentative" }, { status: 400 });
    }
    status = body.status as RSVPStatus;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const auth = await getAuthedClient(username);
  if (!auth) return NextResponse.json({ error: "Google auth unavailable" }, { status: 500 });

  const calendar = google.calendar({ version: "v3", auth });

  try {
    // Fetch the event to find the user's attendee entry
    const existing = await calendar.events.get({ calendarId: "primary", eventId });
    const ev = existing.data;

    const updatedAttendees = (ev.attendees || []).map((a) => {
      if (a.self) return { ...a, responseStatus: status };
      return a;
    });

    await calendar.events.patch({
      calendarId: "primary",
      eventId,
      requestBody: { attendees: updatedAttendees },
    });

    await emitAuditEvent({
      username,
      source: "calendar",
      headline: `RSVP ${status} for "${ev.summary || eventId}"`,
      context: `Event: ${ev.summary}\nDate: ${ev.start?.dateTime || ev.start?.date}`,
      rationale: `User responded ${status} to calendar invite.`,
      tags: ["calendar", "rsvp", status],
    });

    return NextResponse.json({ success: true, status });
  } catch (e) {
    console.error("Calendar RSVP error:", e);
    return NextResponse.json({ error: "Failed to update RSVP" }, { status: 500 });
  }
}
