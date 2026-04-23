import { type NextRequest, NextResponse } from "next/server";
import { isGoogleConnected } from "@/lib/google/auth";
import { getEventsForMonth } from "@/lib/google/calendar";

// GET /api/calendar/month?year=2026&month=3  (month is 0-indexed)
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const yearParam = searchParams.get("year");
  const monthParam = searchParams.get("month");

  if (!yearParam || !monthParam) {
    return NextResponse.json(
      { connected: false, events: [], message: "Missing year or month parameter." },
      { status: 400 }
    );
  }

  const year = parseInt(yearParam, 10);
  const month = parseInt(monthParam, 10);

  if (isNaN(year) || isNaN(month) || month < 0 || month > 11) {
    return NextResponse.json(
      { connected: false, events: [], message: "Invalid year or month." },
      { status: 400 }
    );
  }

  if (!(await isGoogleConnected())) {
    return NextResponse.json({
      connected: false,
      events: [],
      message: "Google Calendar not connected.",
    });
  }

  try {
    const events = await getEventsForMonth(year, month);
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
