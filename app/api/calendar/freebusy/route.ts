/**
 * POST /api/calendar/freebusy
 *
 * Given a list of attendee emails + a duration + a date window, returns
 * structured slot suggestions where everyone is free inside their working
 * hours.
 *
 * Body:
 * {
 *   attendeeEmails: string[],   // required, at least one
 *   durationMin?: number,        // default 30
 *   windowStart?: string,        // ISO datetime, default = now
 *   windowEnd?: string,          // ISO datetime, default = now + 5 working days
 *   maxSlots?: number            // default 8
 * }
 *
 * Returns: { slots: SlotSuggestion[] }, or { slots: [], calendarUnavailable: true }
 * when the owner's own calendar could not be read — never slots that may sit
 * on top of meetings it could not see (B5).
 *
 * Reads every connected calendar (Google and/or Microsoft 365). The owner's
 * window is their settings workStart–workEnd; attendees are assumed 09:00–17:00.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { connectedCalendars, describeProviders, readCalendar, type UnifiedCalendar } from "@/lib/calendar/unified";
import { fetchAndFindSlots, hoursFromHHMM } from "@/lib/calendar/find-slots";
import { dayIn } from "@/lib/away/calendar";
import { listUserContacts } from "@/lib/contacts/user-store";
import { findContactByName } from "@/lib/contacts-lookup";
import { getSettings } from "@/lib/settings/store";
import { resolveTimezone } from "@/lib/timezone";

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const connected = await connectedCalendars(username);
  if (connected.length === 0) {
    return NextResponse.json(
      { error: "No calendar connected", slots: [] },
      { status: 200 } // soft-fail: caller falls back to "no suggestions"
    );
  }

  const body = await req.json().catch(() => ({}));
  const attendeeEmails: string[] = Array.isArray(body.attendeeEmails)
    ? body.attendeeEmails.map((e: unknown) => String(e).trim()).filter(Boolean)
    : [];

  if (attendeeEmails.length === 0) {
    return NextResponse.json({ error: "No attendees provided", slots: [] }, { status: 400 });
  }

  const durationMin: number = Number(body.durationMin) || 30;
  const maxSlots: number = Number(body.maxSlots) || 8;
  const now = new Date();

  // Default window: next 5 working days (≈ 1 week).
  const windowStart = body.windowStart ? new Date(body.windowStart) : now;
  const windowEnd = body.windowEnd
    ? new Date(body.windowEnd)
    : new Date(now.getTime() + 7 * 24 * 3_600_000);

  // ── Resolve owner timezone ──────────────────────────────────────────────────
  // resolveTimezone expects a non-null object; pass a tz-only stub when there
  // are no stored settings so we still honour the request header / fallback.
  const settings = await getSettings(username).catch((err) => {
    console.warn("[freebusy] getSettings failed; falling back to Europe/London:", err instanceof Error ? err.message : err);
    return null;
  });
  const userTimezone = resolveTimezone(settings ?? { timezone: "Europe/London" }, req);

  // ── Resolve attendee names + tz from contacts ───────────────────────────────
  const contacts = await listUserContacts(username).catch((err) => {
    console.warn("[freebusy] listUserContacts failed; proceeding without contact-derived names/timezones:", err instanceof Error ? err.message : err);
    return [];
  });
  const attendees = attendeeEmails.map((email) => {
    const contact = findContactByName(email, contacts);
    return {
      name: contact?.name || email,
      email,
      // Without per-contact tz from Slack, assume owner's tz so we don't
      // over-constrain. Mirrors what the AI tool does today.
      timezone: userTimezone,
    };
  });

  // ── Owner's existing events for the window ─────────────────────────────────
  // Reading the events (not freebusy) so Focus/Reclaim holds count. The days
  // are the owner's local days: the UTC date cut the window a day short for
  // anyone ahead of UTC late in the evening, or behind it early.
  const startDate = dayIn(windowStart.getTime(), userTimezone);
  const endDate   = dayIn(windowEnd.getTime(), userTimezone);
  let mine: UnifiedCalendar;
  try {
    mine = await readCalendar(username, { from: startDate, to: endDate }, userTimezone, { providers: connected });
  } catch (err) {
    mine = { events: [], providers: [], degraded: connected.map((provider) => ({ provider, error: err instanceof Error ? err.message : String(err) })), clashes: [] };
  }
  if (mine.degraded.length > 0) {
    // A failed read used to become "free all day" and suggest slots on top of
    // real meetings. Unknown is not free.
    return NextResponse.json({
      error: `Could not read your ${describeProviders(mine.degraded)}, so free times are unknown.`,
      calendarUnavailable: true,
      degraded: mine.degraded,
      slots: [],
      userTimezone,
    });
  }
  const userBusy = mine.events
    .filter((e) => !e.isAllDay && e.myResponseStatus !== "declined")
    .map((e) => ({ start: e.start, end: e.end }));

  try {
    const slots = await fetchAndFindSlots(username, {
      attendees,
      durationMin,
      windowStart,
      windowEnd,
      userBusy,
      userTimezone,
      maxSlots,
      ownerWorkStart: hoursFromHHMM(settings?.workStart, 9),
      ownerWorkEnd: hoursFromHHMM(settings?.workEnd, 17),
    });

    return NextResponse.json({ slots, userTimezone });
  } catch (err) {
    console.error("[freebusy] computation failed:", err);
    return NextResponse.json(
      { error: "Failed to compute availability", slots: [] },
      { status: 500 }
    );
  }
}
