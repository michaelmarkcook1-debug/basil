import { NextResponse } from "next/server";
import { isGoogleConnected } from "@/lib/google/auth";
import { getTodayEvents } from "@/lib/google/calendar";

export async function GET() {
  if (!isGoogleConnected()) {
    return NextResponse.json({
      connected: false,
      events: [],
      message: "Google Calendar not connected. Set up OAuth in Settings.",
    });
  }

  try {
    const events = await getTodayEvents();
    return NextResponse.json({
      connected: true,
      events,
      message: events.length === 0 ? "No events today." : `${events.length} events today.`,
    });
  } catch (e) {
    console.error("Calendar API error:", e);
    return NextResponse.json({
      connected: false,
      events: [],
      message: `Calendar error: ${e instanceof Error ? e.message : "Unknown"}`,
    });
  }
}
