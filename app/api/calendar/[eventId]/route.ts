import { NextResponse } from "next/server";
import { isGoogleConnected } from "@/lib/google/auth";
import { updateCalendarEvent, cancelEvent } from "@/lib/google/calendar";
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

// DELETE /api/calendar/[eventId]  — cancel a meeting (organiser) or leave it (guest).
// Body (optional): { notify?: boolean = true, note?: string }. Telling people is
// the default: a cancel the guests never hear about is the failure this replaces.
export async function DELETE(
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

  const body = (await req.json().catch(() => ({}))) as { notify?: unknown; note?: unknown }; // ci-ok: no body (Schedule's delete) → defaults
  const notify = body?.notify !== false;
  const note = typeof body?.note === "string" ? body.note : undefined;

  try {
    const result = await cancelEvent(username, eventId, { notify, note });
    const verb = result.role === "organiser" ? "Cancelled" : "Left";
    await emitAuditEvent({
      username,
      source: "calendar",
      headline: `${verb} "${result.summary}"`,
      context: [
        result.told.length ? `Told: ${result.told.join(", ")}` : "No one notified",
        note && `Note: ${note.slice(0, 300)}`,
        result.role === "organiser" && note && notify && !result.noteSent && "The note email failed to send",
      ].filter(Boolean).join("\n"),
      rationale: result.role === "organiser"
        ? "Cancelled the meeting from Basil; Google sent the cancellation."
        : "Declined and removed the meeting from Basil.",
      tags: ["calendar", result.role === "organiser" ? "cancelled" : "declined"],
    });
    return NextResponse.json({ success: true, ...result });
  } catch (e) {
    console.error("Calendar cancel error:", e);
    return NextResponse.json({ error: "The meeting was not cancelled. Try again, or cancel it in Google Calendar." }, { status: 500 });
  }
}
