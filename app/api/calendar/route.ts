import { type NextRequest, NextResponse } from "next/server";
import { isGoogleConnected } from "@/lib/google/auth";
import { getTodayEvents } from "@/lib/google/calendar";
import { getSessionUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings/store";
import { resolveTimezone } from "@/lib/timezone";

export async function GET(req: NextRequest) {
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
    const settings = await getSettings(username);
    const timezone = resolveTimezone(settings, req);
    const events = await getTodayEvents(username, timezone);
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
