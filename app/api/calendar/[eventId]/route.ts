import { NextResponse } from "next/server";
import { isGoogleConnected } from "@/lib/google/auth";
import { updateCalendarEvent, deleteCalendarEvent } from "@/lib/google/calendar";
import { emitAuditEvent } from "@/lib/events/audit";
import { getSessionUser } from "@/lib/auth";

// PATCH /api/calendar/[eventId]  — update an existing event
export async function PATCH(
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

  try {
    const body = await req.json();
    const { title, date, startTime, duration, attendees } = body;

    await updateCalendarEvent(username, eventId, { title, date, startTime, duration, attendees });

    await emitAuditEvent({
      username,
      source: "calendar",
      headline: `Updated event ${eventId}${title ? ` — "${title}"` : ""}`,
      context: [
        title      && `Title: ${title}`,
        date       && `Date: ${date}`,
        startTime  && `Start: ${startTime}`,
        duration   && `Duration: ${duration}m`,
      ].filter(Boolean).join("\n"),
      rationale: "Updated the event directly on the Schedule page.",
      tags: ["calendar", "updated"],
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("Calendar update error:", e);
    return NextResponse.json({ error: "Failed to update event" }, { status: 500 });
  }
}

// DELETE /api/calendar/[eventId]  — delete an event
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ eventId: string }> }
) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  if (!(await isGoogleConnected(username))) {
    return NextResponse.json({ error: "Google Calendar not connected." }, { status: 401 });
  }

  const { eventId } = await params;
  if (!eventId) return NextResponse.json({ error: "Missing eventId" }, { status: 400 });

  try {
    await deleteCalendarEvent(username, eventId);

    await emitAuditEvent({
      username,
      source: "calendar",
      headline: `Deleted event ${eventId}`,
      context: "",
      rationale: "Deleted the event on the Schedule page.",
      tags: ["calendar", "deleted"],
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("Calendar delete error:", e);
    return NextResponse.json({ error: "Failed to delete event" }, { status: 500 });
  }
}
