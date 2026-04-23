import { NextResponse } from "next/server";
import { isGoogleConnected } from "@/lib/google/auth";
import { getEventsForDays } from "@/lib/google/calendar";

// GET /api/calendar/upcoming — returns next 2 days of events
export async function GET() {
  if (!(await isGoogleConnected())) {
    return NextResponse.json({
      connected: false,
      events: [],
      message: "Google Calendar not connected.",
    });
  }

  try {
    const events = await getEventsForDays(2);
    return NextResponse.json({
      connected: true,
      events,
      message: `${events.length} events in the next 2 days.`,
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
