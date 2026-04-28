import { NextResponse } from "next/server";
import { isGoogleConnected } from "@/lib/google/auth";
import { getEventsForMonth } from "@/lib/google/calendar";
import { getSessionUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings/store";
import { resolveTimezone } from "@/lib/timezone";

// GET /api/calendar/month?year=2026&month=3  (month is 0-indexed)
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const yearParam  = searchParams.get("year");
  const monthParam = searchParams.get("month");

  if (!yearParam || !monthParam) {
    return NextResponse.json(
      { connected: false, events: [], message: "Missing year or month parameter." },
      { status: 400 }
    );
  }

  const year  = parseInt(yearParam,  10);
  const month = parseInt(monthParam, 10);

  if (isNaN(year) || isNaN(month) || month < 0 || month > 11) {
    return NextResponse.json(
      { connected: false, events: [], message: "Invalid year or month." },
      { status: 400 }
    );
  }

  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  if (!(await isGoogleConnected(username))) {
    return NextResponse.json({
      connected: false,
      events: [],
      message: "Google Calendar not connected.",
    });
  }

  try {
    const settings  = await getSettings(username);
    const timezone  = resolveTimezone(settings, request);
    const events    = await getEventsForMonth(username, year, month, timezone);
    return NextResponse.json({
      connected: true,
      events,
      message: `${events.length} events in ${year}-${String(month + 1).padStart(2, "0")}.`,
    });
  } catch (e) {
    console.error("Calendar month error:", e);
    return NextResponse.json({
      connected: false,
      events: [],
      message: `Calendar error: ${e instanceof Error ? e.message : "Unknown"}`,
    });
  }
}
