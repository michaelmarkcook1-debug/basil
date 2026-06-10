import { NextResponse } from "next/server";
import { isGoogleConnected, getAuthedClient } from "@/lib/google/auth";
import { getSessionUser } from "@/lib/auth";
import { google } from "googleapis";
import { emitAuditEvent } from "@/lib/events/audit";

/**
 * POST /api/calendar/[eventId]/forward
 *
 * Forwards a calendar invite by adding new email addresses as attendees.
 * Google Calendar automatically sends them an invite email.
 *
 * Body: { emails: string[] }
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

  let emails: string[];
  try {
    const body = await req.json();
    emails = (body.emails || []).map((e: unknown) => String(e).trim()).filter(Boolean);
    if (emails.length === 0) return NextResponse.json({ error: "At least one email is required" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const auth = await getAuthedClient(username);
  if (!auth) return NextResponse.json({ error: "Google auth unavailable" }, { status: 500 });

  try {
    const calendar = google.calendar({ version: "v3", auth });

    // Fetch the event to merge with existing attendees
    const { data: ev } = await calendar.events.get({ calendarId: "primary", eventId });

    const existingEmails = new Set((ev.attendees || []).map((a) => (a.email || "").toLowerCase()));
    const newAttendees = emails
      .filter((email) => !existingEmails.has(email.toLowerCase()))
      .map((email) => ({ email }));

    if (newAttendees.length === 0) {
      return NextResponse.json({ success: true, message: "All recipients are already attendees" });
    }

    const updatedAttendees = [
      ...(ev.attendees || []),
      ...newAttendees,
    ];

    await calendar.events.patch({
      calendarId: "primary",
      eventId,
      // sendUpdates="all" ensures Google sends invite emails to newly added attendees
      sendUpdates: "all",
      requestBody: { attendees: updatedAttendees },
    });

    await emitAuditEvent({
      username,
      source: "calendar",
      headline: `Forwarded "${ev.summary || eventId}" to ${newAttendees.map((a) => a.email).join(", ")}`,
      context: `Event: ${ev.summary}\nForwarded to: ${emails.join(", ")}`,
      rationale: "User forwarded a calendar invite to additional recipients.",
      tags: ["calendar", "forward"],
    });

    return NextResponse.json({ success: true, added: newAttendees.length });
  } catch (e) {
    console.error("[calendar/forward] error:", e);
    return NextResponse.json({ error: "Failed to forward invite" }, { status: 500 });
  }
}
