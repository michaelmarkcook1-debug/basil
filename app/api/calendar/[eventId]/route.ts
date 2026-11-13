import { NextResponse } from "next/server";
// Edits and cancels go to the calendar the event lives on: an "ms:" id is an
// Outlook event (Microsoft Graph), anything else Google (lib/calendar/writes.ts).
import { updateCalendarEvent, cancelEvent, CalendarNotConnectedError, CALENDAR_NAME, eventProvider } from "@/lib/calendar/writes";
import { emitAuditEvent } from "@/lib/events/audit";
import { getSessionUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings/store";
import { parseAttendees } from "@/lib/calendar/attendee-emails";

// PATCH /api/calendar/[eventId]  — update an existing event
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ eventId: string }> }
) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { eventId } = await params;
  if (!eventId) return NextResponse.json({ error: "Missing eventId" }, { status: 400 });

  try {
    const body = await req.json();
    const { title, date, startTime, duration } = body;

    // The guest list REPLACES the event's guests, so an entry that is not an
    // address is refused, never dropped. "Name <email>" yields its address.
    let attendees: string[] | undefined;
    if (Array.isArray(body.attendees)) {
      const parsed = parseAttendees(body.attendees);
      if (parsed.bad.length) {
        return NextResponse.json({ error: `Not an email address: ${parsed.bad.join(", ")}` }, { status: 400 });
      }
      attendees = parsed.emails;
    }

    // Outlook needs the zone the wall-clock times are in; Google keeps the event's own.
    const timezone = (await getSettings(username).catch(() => null))?.timezone || undefined; // ci-ok: settings optional; Outlook falls back to Europe/London
    await updateCalendarEvent(username, eventId, { title, date, startTime, duration, attendees }, timezone);

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
    if (e instanceof CalendarNotConnectedError) return NextResponse.json({ error: e.message }, { status: 401 });
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
        ? `Cancelled the meeting from Basil; ${result.provider === "microsoft" ? "Outlook" : "Google"} sent the cancellation.`
        : "Declined and removed the meeting from Basil.",
      tags: ["calendar", result.role === "organiser" ? "cancelled" : "declined"],
    });
    return NextResponse.json({ success: true, ...result });
  } catch (e) {
    if (e instanceof CalendarNotConnectedError) return NextResponse.json({ error: e.message }, { status: 401 });
    console.error("Calendar cancel error:", e);
    return NextResponse.json({ error: `The meeting was not cancelled. Try again, or cancel it in ${CALENDAR_NAME[eventProvider(eventId)]}.` }, { status: 500 });
  }
}
