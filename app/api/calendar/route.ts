import { NextResponse } from "next/server";
import { isGoogleConnected } from "@/lib/google/auth";
import { getTodayEvents } from "@/lib/google/calendar";
import { getSessionUser } from "@/lib/auth";

export async function GET() {
  const username = (await getSessionUser());
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  if (!(await isGoogleConnected(username))) {
    return NextResponse.json({
      connected: false,
      events: [],
      message: "Google Calendar not connected. Set up OAuth in Settings.",
    });
  }

  try {
    const events = await getTodayEvents(username);
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
