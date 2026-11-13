import { NextResponse } from "next/server";
import { connectedCalendars, describeProviders, readCalendar } from "@/lib/calendar/unified";
import { getSessionUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings/store";
import { resolveTimezone } from "@/lib/timezone";

// GET /api/calendar/upcoming — rolling 14-day window from every connected
// calendar (Google and/or Microsoft 365), merged, each event tagged with its
// provider. `degraded`: connected calendars that could not be read (their
// events are missing, not absent). `clashes`: overlapping meetings you have
// not declined, across both calendars.
export async function GET(req: Request) {
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
    const timezone  = resolveTimezone(settings, req);
    const { events, providers, degraded, clashes } = await readCalendar(username, { days: 14 }, timezone, { providers: connected });
    if (providers.length === 0) {
      // Every connected calendar failed: same answer as before for the pages,
      // plus what failed.
      return NextResponse.json({
        connected: false,
        events: [],
        providers,
        degraded,
        clashes: [],
        error: `Could not read your ${describeProviders(degraded)}.`,
        message: "Calendar error — please try again",
      });
    }
    return NextResponse.json({
      connected: true,
      events,
      providers,
      degraded,
      clashes,
      message: `${events.length} events in the next 14 days.`
        + (degraded.length ? ` Your ${describeProviders(degraded)} could not be read, so its events are missing.` : ""),
    });
  } catch (e) {
    console.error("Calendar upcoming error:", e);
    return NextResponse.json({
      connected: false,
      events: [],
      message: "Calendar error — please try again",
    });
  }
}
