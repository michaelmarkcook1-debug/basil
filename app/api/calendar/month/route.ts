import { NextResponse } from "next/server";
import { connectedCalendars, describeProviders, readCalendar } from "@/lib/calendar/unified";
import { getSessionUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings/store";
import { resolveTimezone } from "@/lib/timezone";

// GET /api/calendar/month?year=2026&month=3  (month is 0-indexed)
// Every connected calendar (Google and/or Microsoft 365), merged; adds
// `providers`, `degraded` (calendars that could not be read) and `clashes`.
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

  const connected = await connectedCalendars(username);
  if (connected.length === 0) {
    return NextResponse.json({
      connected: false,
      events: [],
      providers: [],
      degraded: [],
      clashes: [],
      message: "No calendar connected.",
    });
  }

  try {
    const settings  = await getSettings(username);
    const timezone  = resolveTimezone(settings, request);
    const { events, providers, degraded, clashes } = await readCalendar(username, { year, month }, timezone, { providers: connected });
    if (providers.length === 0) {
      return NextResponse.json({
        connected: false,
        events: [],
        providers,
        degraded,
        clashes: [],
        error: `Could not read your ${describeProviders(degraded)}.`,
        message: "Calendar error — please try again",
      }, { status: 502 }); // connected, but unreadable: the page shows "couldn't load", not "not connected"
    }
    return NextResponse.json({
      connected: true,
      events,
      providers,
      degraded,
      clashes,
      message: `${events.length} events in ${year}-${String(month + 1).padStart(2, "0")}.`
        + (degraded.length ? ` Your ${describeProviders(degraded)} could not be read, so its events are missing.` : ""),
    });
  } catch (e) {
    console.error("Calendar month error:", e);
    return NextResponse.json({
      connected: false,
      events: [],
      error: "Calendar error — please try again",
      message: "Calendar error — please try again",
    }, { status: 502 });
  }
}
