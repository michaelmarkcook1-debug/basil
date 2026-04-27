import { NextResponse } from "next/server";
import { isGoogleConnected } from "@/lib/google/auth";
import { getEventsForDays } from "@/lib/google/calendar";
import { getSessionUser } from "@/lib/auth";

// GET /api/calendar/upcoming — returns rolling 14-day window of events
export async function GET() {
  const username = (await getSessionUser());
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  if (!(await isGoogleConnected(username))) {
    return NextResponse.json({
      connected: false,
      events: [],
      message: "Google Calendar not connected.",
    });
  }

  try {
    const events = await getEventsForDays(username, 14);
    return NextResponse.json({
      connected: true,
      events,
      message: `${events.length} events in the next 14 days.`,
    });
  } catch (e) {
    console.error("Calendar upcoming error:", e);
    return NextResponse.json({
      connected: false,
      events: [],
      message: `Calendar error: ${e instanceof Error ? e.message : "Unknown"}`,
    });
  }
}
