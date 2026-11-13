import { NextResponse } from "next/server";
import { CALENDAR_NAME, createEventOn, primaryCalendar } from "@/lib/calendar/writes";
import { emitAuditEvent } from "@/lib/events/audit";
import { getSessionUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings/store";
import { parseAttendees } from "@/lib/calendar/attendee-emails";

// POST /api/calendar/create — create a calendar event on the primary calendar:
// Google when connected, otherwise Microsoft 365. Body `provider`
// ("google" | "microsoft") picks one explicitly.
export async function POST(req: Request) {
  const username = (await getSessionUser());
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const body = await req.json().catch(() => null); // ci-ok: unreadable body → 400 below
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const asked = body.provider === "google" || body.provider === "microsoft" ? body.provider : null;
  const provider = await primaryCalendar(username, asked);
  if (!provider) {
    return NextResponse.json(
      { error: asked ? `${CALENDAR_NAME[asked as "google" | "microsoft"]} not connected.` : "No calendar connected. Connect Google or Microsoft 365 in Settings." },
      { status: 401 }
    );
  }

  try {
    const { title, attendees, date, startTime, endTime, duration, description, location, zoomLink, addVideoCall, timezone } = body;

    if (!title || !date || !startTime) {
      return NextResponse.json(
        { error: "Missing required fields: title, date, startTime." },
        { status: 400 }
      );
    }

    // Only keep valid-looking email addresses as attendees — a malformed entry
    // makes Google reject the whole insert. "Name <email>" (what the guest
    // autocomplete inserts) yields its address; it used to be dropped.
    const cleanAttendees: string[] = Array.isArray(attendees) ? parseAttendees(attendees).emails : [];

    // Default the timezone to the user's configured one so wall-clock times land
    // in their local zone, not a hardcoded default.
    const tz = typeof timezone === "string" && timezone.trim()
      ? timezone.trim()
      : (await getSettings(username).catch(() => null))?.timezone; // ci-ok: settings optional; TZ falls back to calendar default

    const result = await createEventOn(username, provider, {
      title,
      attendees: cleanAttendees,
      date,
      startTime,
      duration: typeof duration === "number" && duration > 0 ? duration : 30,
      ...(typeof endTime === "string" && endTime ? { endTime } : {}),
      ...(typeof description === "string" && description.trim() ? { description } : {}),
      ...(typeof location === "string" && location.trim() ? { location } : {}),
      ...(zoomLink ? { zoomLink: String(zoomLink) } : {}),
      ...(addVideoCall ? { addVideoCall: true } : {}),
      ...(tz ? { timezone: tz } : {}),
    });

    await emitAuditEvent({
      username,
      source: "calendar",
      headline: `Created "${title}" on ${date} ${startTime}${cleanAttendees.length ? ` — invited ${cleanAttendees.length}` : ""}`,
      context: `Attendees: ${cleanAttendees.join(", ") || "(none)"}\nStart: ${startTime}${endTime ? ` End: ${endTime}` : ` Duration: ${duration || 30}m`}\nLink: ${result.htmlLink ?? "(pending)"}`,
      rationale: `Created from the New Event form on ${CALENDAR_NAME[provider]}.`,
      entityName: cleanAttendees[0],
      tags: ["calendar", "scheduled"],
    });

    return NextResponse.json({
      success: true,
      eventId: result.id,
      htmlLink: result.htmlLink,
      attendeeCount: cleanAttendees.length,
      provider,
    });
  } catch (e) {
    console.error("Calendar create error:", e);
    return NextResponse.json(
      { error: "Failed to create event — please try again" },
      { status: 500 }
    );
  }
}
