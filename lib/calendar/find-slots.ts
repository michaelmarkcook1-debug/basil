/**
 * Mutual-availability slot finder.
 *
 * Given the authenticated user's own busy blocks plus a list of attendees with
 * their busy intervals and timezones, returns the next N slots of `durationMin`
 * minutes that work inside everyone's working-hour window.
 *
 * Pure / deterministic — caller is responsible for fetching the busy data.
 */

import { checkFreeBusy, type BusyPeriod } from "@/lib/google/calendar";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AttendeeInput {
  /** Display name (for label generation). */
  name: string;
  /** Email address — used to fetch their busy via Google free/busy API. */
  email: string;
  /** IANA timezone, e.g. "Europe/London". Defaults to UTC if absent. */
  timezone?: string;
}

export interface SlotSuggestion {
  /** ISO UTC start. */
  start: string;
  /** ISO UTC end. */
  end: string;
  /** "Wed 4 Jun, 14:00" in the user's local tz — for the primary label. */
  label: string;
  /** Per-attendee local time, formatted "HH:MM (Name, City)" — for tooltips. */
  attendeeLocalTimes: Array<{ name: string; localTime: string }>;
}

export interface FindSlotsOptions {
  durationMin: number;
  /** ISO datetime to start scanning. Defaults to now. */
  windowStart: Date;
  /** ISO datetime to stop scanning. */
  windowEnd: Date;
  /** User's own busy blocks (already includes Focus / Reclaim holds). */
  userBusy: BusyPeriod[];
  /** Attendee busy blocks keyed by email. */
  attendeeBusy: Map<string, BusyPeriod[]>;
  /** All attendees (used for working-hours and label generation). */
  attendees: AttendeeInput[];
  /** Owner timezone — for the primary label. */
  userTimezone: string;
  /** Hour-of-day window in everyone's *local* time. Defaults 9–17. */
  workingHourStart?: number;
  workingHourEnd?: number;
  /** Cap on returned slots. Defaults 8. */
  maxSlots?: number;
  /** Step in minutes between candidate slots. Defaults 30. */
  stepMin?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Hour-of-day a UTC moment maps to in the given timezone (e.g. 14.5 = 14:30). */
function hourInTz(utcMs: number, tz: string): number {
  try {
    // Get hour and minute strings via locale formatting in the target tz
    const d = new Date(utcMs);
    const hourStr = d.toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: tz });
    const minStr  = d.toLocaleString("en-US", { minute: "numeric",                   timeZone: tz });
    return parseFloat(hourStr) + (parseFloat(minStr) / 60);
  } catch {
    // Fall back to UTC hour if the timezone string is malformed.
    return new Date(utcMs).getUTCHours();
  }
}

/** Returns true when the [tStart, tEnd) interval overlaps any of the busy blocks. */
function overlapsBusy(tStart: number, tEnd: number, busy: BusyPeriod[]): boolean {
  return busy.some((b) => {
    const bs = new Date(b.start).getTime();
    const be = new Date(b.end).getTime();
    return tStart < be && tEnd > bs;
  });
}

// ── Core ──────────────────────────────────────────────────────────────────────

/**
 * Compute the next N slots that fit everyone's working hours and don't overlap
 * anyone's existing calendar events.
 */
export function findMutualSlots(opts: FindSlotsOptions): SlotSuggestion[] {
  const {
    durationMin,
    windowStart,
    windowEnd,
    userBusy,
    attendeeBusy,
    attendees,
    userTimezone,
    workingHourStart = 9,
    workingHourEnd = 17,
    maxSlots = 8,
    stepMin = 30,
  } = opts;

  const slots: SlotSuggestion[] = [];
  const durationMs = durationMin * 60_000;
  const stepMs = stepMin * 60_000;

  // Merge all busy blocks once — saves per-iteration work.
  const allBusy: BusyPeriod[] = [
    ...userBusy,
    ...Array.from(attendeeBusy.values()).flat(),
  ];

  for (let t = windowStart.getTime(); t < windowEnd.getTime(); t += stepMs) {
    if (slots.length >= maxSlots) break;
    const slotEnd = t + durationMs;

    // 1. Must not overlap any existing meeting (user OR any attendee).
    if (overlapsBusy(t, slotEnd, allBusy)) continue;

    // 2. The owner must be inside working hours throughout the slot.
    const ownerStartH = hourInTz(t, userTimezone);
    const ownerEndH   = hourInTz(slotEnd, userTimezone);
    if (ownerStartH < workingHourStart || ownerEndH > workingHourEnd) continue;

    // 3. Every attendee must also be inside their own working hours.
    const allAttendeesOk = attendees.every((a) => {
      const tz = a.timezone || "UTC";
      const hStart = hourInTz(t, tz);
      const hEnd   = hourInTz(slotEnd, tz);
      return hStart >= workingHourStart && hEnd <= workingHourEnd;
    });
    if (!allAttendeesOk) continue;

    // Build the human-readable label.
    const labelDate = new Date(t).toLocaleString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: userTimezone,
    });

    const attendeeLocalTimes = attendees.map((a) => {
      const tz = a.timezone || "UTC";
      const localTime = new Date(t).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: tz,
      });
      const cityHint = tz.includes("/") ? tz.split("/").pop()?.replace(/_/g, " ") : tz;
      return { name: a.name, localTime: `${localTime} (${cityHint})` };
    });

    slots.push({
      start: new Date(t).toISOString(),
      end: new Date(slotEnd).toISOString(),
      label: labelDate,
      attendeeLocalTimes,
    });
  }

  return slots;
}

// ── Convenience: fetch + compute in one call ─────────────────────────────────

/**
 * Fetch attendees' busy blocks from Google free/busy and compute mutual slots.
 *
 * Caller-supplied `userBusy` lets the caller pass authenticated-primary events
 * (so Focus time / Reclaim holds count) rather than freebusy on the owner.
 */
export async function fetchAndFindSlots(
  username: string,
  params: {
    attendees: AttendeeInput[];
    durationMin: number;
    windowStart: Date;
    windowEnd: Date;
    userBusy: BusyPeriod[];
    userTimezone: string;
    workingHourStart?: number;
    workingHourEnd?: number;
    maxSlots?: number;
  }
): Promise<SlotSuggestion[]> {
  const emails = params.attendees.map((a) => a.email).filter(Boolean);
  const attendeeBusy = new Map<string, BusyPeriod[]>();

  if (emails.length > 0) {
    try {
      const fb = await checkFreeBusy(username, emails, params.windowStart, params.windowEnd);
      for (const result of fb) {
        attendeeBusy.set(result.email, result.error ? [] : result.busy);
      }
    } catch {
      // Continue with empty attendee busy — slots still respect user's own
      // calendar and working hours, which is better than failing outright.
    }
  }

  return findMutualSlots({
    durationMin: params.durationMin,
    windowStart: params.windowStart,
    windowEnd: params.windowEnd,
    userBusy: params.userBusy,
    attendeeBusy,
    attendees: params.attendees,
    userTimezone: params.userTimezone,
    workingHourStart: params.workingHourStart,
    workingHourEnd: params.workingHourEnd,
    maxSlots: params.maxSlots,
  });
}
