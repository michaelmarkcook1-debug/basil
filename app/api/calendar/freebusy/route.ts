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
 * Returns: { slots: SlotSuggestion[] }
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isGoogleConnected } from "@/lib/google/auth";
import { getEventsForDateRange } from "@/lib/google/calendar";
import { fetchAndFindSlots } from "@/lib/calendar/find-slots";
import { listUserContacts } from "@/lib/contacts/user-store";
import { findContactByName } from "@/lib/contacts-lookup";
import { getSettings } from "@/lib/settings/store";
import { resolveTimezone } from "@/lib/timezone";

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  if (!(await isGoogleConnected(username))) {
    return NextResponse.json(
      { error: "Google Calendar not connected", slots: [] },
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
  // Using getEventsForDateRange (not freebusy) so Focus/Reclaim holds count.
  const startDate = windowStart.toISOString().slice(0, 10);
  const endDate   = windowEnd.toISOString().slice(0, 10);
  const myEvents = await getEventsForDateRange(username, startDate, endDate, userTimezone).catch(() => []);
  const userBusy = myEvents
    .filter((e) => !e.isAllDay)
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
