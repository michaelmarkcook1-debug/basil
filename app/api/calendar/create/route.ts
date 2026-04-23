import { NextResponse } from "next/server";
import { isGoogleConnected } from "@/lib/google/auth";
import { createCalendarEvent } from "@/lib/google/calendar";
import { emitAuditEvent } from "@/lib/events/audit";

// POST /api/calendar/create — create a calendar event
export async function POST(req: Request) {
  if (!(await isGoogleConnected())) {
    return NextResponse.json(
      { error: "Google Calendar not connected." },
      { status: 401 }
    );
  }

  try {
    const body = await req.json();
    const { title, attendees, date, startTime, duration } = body;

    if (!title || !date || !startTime) {
      return NextResponse.json(
        { error: "Missing required fields: title, date, startTime." },
        { status: 400 }
      );
    }

    const result = await createCalendarEvent({
      title,
      attendees: attendees || [],
      date,
      startTime,
      duration: duration || 30,
    });

    await emitAuditEvent({
      source: "calendar",
      headline: `Scheduled "${title}" on ${date} ${startTime} UK`,
      context: `Attendees: ${(attendees || []).join(", ")}\nDuration: ${duration || 30}m\nLink: ${result.htmlLink ?? "(pending)"}`,
      rationale: "Michael approved the meeting on the Schedule page.",
      entityName: Array.isArray(attendees) ? attendees[0] : undefined,
      tags: ["calendar", "scheduled", "schedule-page"],
    });

    return NextResponse.json({
      success: true,
      eventId: result.id,
      htmlLink: result.htmlLink,
    });
  } catch (e) {
    console.error("Calendar create error:", e);
    return NextResponse.json(
      { error: `Failed to create event: ${e instanceof Error ? e.message : "Unknown"}` },
      { status: 500 }
    );
  }
}
