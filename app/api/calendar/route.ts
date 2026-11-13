import { type NextRequest, NextResponse } from "next/server";
import { connectedCalendars, describeProviders, readCalendar } from "@/lib/calendar/unified";
import { getSessionUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings/store";
import { resolveTimezone } from "@/lib/timezone";

// GET /api/calendar — today's events from every connected calendar (Google
// and/or Microsoft 365), each tagged with its provider. `degraded` lists a
// connected calendar that could not be read; `clashes` lists overlaps.
export async function GET(req: NextRequest) {
  const username = (await getSessionUser());
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const connected = await connectedCalendars(username);
  if (connected.length === 0) {
    return NextResponse.json({
      connected: false,
      events: [],
      providers: [],
      degraded: [],
      clashes: [],
      message: "No calendar connected. Connect Google or Microsoft 365 in Settings.",
    });
  }

  try {
    const settings = await getSettings(username);
    const timezone = resolveTimezone(settings, req);
    const { events, providers, degraded, clashes } = await readCalendar(username, { days: 1 }, timezone, { providers: connected });
    if (providers.length === 0) {
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
      message: (events.length === 0 ? "No events today." : `${events.length} events today.`)
        + (degraded.length ? ` Your ${describeProviders(degraded)} could not be read, so its events are missing.` : ""),
    });
  } catch (e) {
    console.error("Calendar API error:", e);
    return NextResponse.json({
      connected: false,
      events: [],
      message: "Calendar error — please try again",
    });
  }
}
