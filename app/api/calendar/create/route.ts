import { NextResponse } from "next/server";
import { isGoogleConnected } from "@/lib/google/auth";
import { createCalendarEvent } from "@/lib/google/calendar";
import { emitAuditEvent } from "@/lib/events/audit";
import { getSessionUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings/store";

// POST /api/calendar/create — create a calendar event
export async function POST(req: Request) {
  const username = (await getSessionUser());
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  if (!(await isGoogleConnected(username))) {
    return NextResponse.json(
      { error: "Google Calendar not connected." },
      { status: 401 }
    );
  }

  try {
    const body = await req.json();
    const { title, attendees, date, startTime, endTime, duration, description, location, zoomLink, addVideoCall, timezone } = body;

    if (!title || !date || !startTime) {
      return NextResponse.json(
        { error: "Missing required fields: title, date, startTime." },
        { status: 400 }
      );
    }

    // Only keep valid-looking email addresses as attendees — a malformed entry
    // makes Google reject the whole insert.
    const cleanAttendees: string[] = Array.isArray(attendees)
      ? Array.from(new Set(
          attendees
            .map((a: unknown) => String(a ?? "").trim().toLowerCase())
            .filter((a: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)),
        ))
      : [];

    // Default the timezone to the user's configured one so wall-clock times land
    // in their local zone, not a hardcoded default.
    const tz = typeof timezone === "string" && timezone.trim()
      ? timezone.trim()
      : (await getSettings(username).catch(() => null))?.timezone; // basil-ci-allow-silent-catch: settings optional; TZ falls back to calendar default

    const result = await createCalendarEvent(username, {
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
      rationale: "Created from the New Event form.",
      entityName: cleanAttendees[0],
      tags: ["calendar", "scheduled"],
    });

    return NextResponse.json({
      success: true,
      eventId: result.id,
      htmlLink: result.htmlLink,
      attendeeCount: cleanAttendees.length,
    });
  } catch (e) {
    console.error("Calendar create error:", e);
    return NextResponse.json(
      { error: "Failed to create event — please try again" },
      { status: 500 }
    );
  }
}
