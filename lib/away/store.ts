/**
 * Where the working calendar comes from: the user's settings (working days,
 * bank-holiday region), absences they told Basil about, and out-of-office
 * blocks read from Google Calendar.
 *
 * The calendar read is cached in the user's store and refreshed at most hourly,
 * so the hot paths (listing actions, the Today feed) never wait on Google. If
 * Google cannot be read, the last good read stands — an outage must not make
 * a user on leave look back at work.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { readUserStore, writeUserStore, updateUserStore } from "@/lib/storage/user-store";
import { getSettings } from "@/lib/settings/store";
import { getAbsenceSourceEvents } from "@/lib/google/calendar";
import type { TodayAway } from "@/lib/today/types";
import { suggestedRedateDay } from "./fell-due";
import {
  addDays, awayPeriodsFromEvents, awayStatus, dayIn, daysBetween, defaultHolidayRegion, isIsoDay, DEFAULT_WORKING_DAYS,
  type AwayPeriod, type WorkCalendar,
} from "./calendar";

const FILE = "sage-away.json";
const CALENDAR_REFRESH_MS = 60 * 60 * 1000;
/** How far back and ahead out-of-office blocks are read. */
const LOOK_BACK_DAYS = 45;
const LOOK_AHEAD_DAYS = 120;
/** Absences told to Basil are kept this long after they end, then dropped. */
const KEEP_ENDED_DAYS = 400;
/** A single absence longer than this is a typo, not leave. */
const MAX_PERIOD_DAYS = 366;

interface AwayFile {
  declared: AwayPeriod[];
  calendar?: { periods: AwayPeriod[]; readAt: string };
}
const EMPTY: AwayFile = { declared: [] };

/**
 * The user's working calendar.
 *   refresh "if-stale" (default) re-reads Google when the cached read is over an hour old;
 *   "never" uses only what is stored (for hot paths); "always" forces a read.
 */
export async function getWorkCalendar(
  username: string,
  opts: { refresh?: "if-stale" | "never" | "always" } = {},
): Promise<WorkCalendar> {
  const [settings, stored] = await Promise.all([
    getSettings(username),
    readUserStore<AwayFile>(username, FILE, EMPTY),
  ]);
  const timezone = settings.timezone || "Europe/London";
  let calendarPeriods = stored.calendar?.periods ?? [];

  const mode = opts.refresh ?? "if-stale";
  const readAt = Date.parse(stored.calendar?.readAt ?? "");
  const stale = !Number.isFinite(readAt) || Date.now() - readAt > CALENDAR_REFRESH_MS;
  if (mode === "always" || (mode === "if-stale" && stale)) {
    const fresh = await readCalendarAbsences(username, timezone);
    if (fresh) {
      calendarPeriods = fresh;
      await updateUserStore<AwayFile>(username, FILE, (cur) => ({
        ...EMPTY, ...cur, calendar: { periods: fresh, readAt: new Date().toISOString() },
      }), EMPTY).catch((e) => console.warn("[away] could not store the calendar read:", e instanceof Error ? e.message : e));
    }
  }

  return {
    timezone,
    workingDays: validWorkingDays(settings.workingDays) ?? DEFAULT_WORKING_DAYS,
    holidayRegion: settings.holidayRegion ?? defaultHolidayRegion(timezone),
    away: [...(stored.declared ?? []), ...calendarPeriods].sort((a, b) => (a.start < b.start ? -1 : 1)),
  };
}

async function readCalendarAbsences(username: string, timezone: string): Promise<AwayPeriod[] | null> {
  try {
    const today = dayIn(Date.now(), timezone);
    const events = await getAbsenceSourceEvents(username, addDays(today, -LOOK_BACK_DAYS), addDays(today, LOOK_AHEAD_DAYS), timezone);
    return events ? awayPeriodsFromEvents(events, timezone) : null;
  } catch (e) {
    console.warn("[away] could not read out-of-office blocks from Google Calendar:", e instanceof Error ? e.message : e);
    return null;
  }
}

export function validWorkingDays(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > 7) return null;
  if (!v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return null;
  return [...new Set(v as number[])].sort();
}

export class AwayInputError extends Error {}

/** Record an absence the user told Basil about. Days are inclusive, in the user's timezone. */
export async function declareAway(
  username: string,
  input: { start: string; end: string; label?: string; cover?: string },
): Promise<AwayPeriod> {
  if (!isIsoDay(input.start) || !isIsoDay(input.end)) throw new AwayInputError("Dates must be YYYY-MM-DD.");
  if (input.end < input.start) throw new AwayInputError("The last day is before the first day.");
  if (Date.parse(input.end) - Date.parse(input.start) > MAX_PERIOD_DAYS * 86_400_000) throw new AwayInputError("That is longer than a year.");
  const period: AwayPeriod = {
    id: `basil:${randomUUID().slice(0, 8)}`,
    start: input.start,
    end: input.end,
    source: "basil",
    ...(input.label?.trim() ? { label: input.label.trim().slice(0, 80) } : {}),
    ...(input.cover?.trim() ? { cover: input.cover.trim().slice(0, 120) } : {}),
  };
  const cutoff = addDays(dayIn(Date.now(), "UTC"), -KEEP_ENDED_DAYS);
  await updateUserStore<AwayFile>(username, FILE, (cur) => ({
    ...EMPTY,
    ...cur,
    // Replace an absence with the same dates rather than stacking a duplicate.
    declared: [...(cur.declared ?? []).filter((p) => p.end >= cutoff && !(p.start === period.start && p.end === period.end)), period],
  }), EMPTY);
  return period;
}

/** Remove an absence the user told Basil about. Calendar blocks are removed in Google Calendar. */
export async function removeDeclaredAway(username: string, id: string): Promise<boolean> {
  let removed = false;
  await updateUserStore<AwayFile>(username, FILE, (cur) => {
    const declared = (cur.declared ?? []).filter((p) => {
      if (p.id !== id) return true;
      removed = true;
      return false;
    });
    return { ...EMPTY, ...cur, declared };
  }, EMPTY);
  return removed;
}

/**
 * "I'm back": end any told-to-Basil absence that covers `today` at yesterday,
 * and drop ones that had not started. Calendar blocks are left to Google.
 */
export async function endDeclaredAway(username: string, today: string): Promise<number> {
  let changed = 0;
  const yesterday = addDays(today, -1);
  await updateUserStore<AwayFile>(username, FILE, (cur) => {
    const declared: AwayPeriod[] = [];
    for (const p of cur.declared ?? []) {
      if (p.start <= today && today <= p.end) {
        changed++;
        if (p.start <= yesterday) declared.push({ ...p, end: yesterday });
      } else declared.push(p);
    }
    return { ...EMPTY, ...cur, declared };
  }, EMPTY);
  return changed;
}

/** Forget the cached calendar read so the next request re-reads Google (after Basil adds or removes a block). */
export async function invalidateCalendarAbsences(username: string): Promise<void> {
  const cur = await readUserStore<AwayFile>(username, FILE, EMPTY);
  if (!cur.calendar) return;
  await writeUserStore(username, FILE, { ...cur, calendar: { ...cur.calendar, readAt: new Date(0).toISOString() } });
}

/** Today's away status, shaped for the Today page. Undefined when it cannot be read. */
export async function getTodayAway(username: string): Promise<TodayAway | undefined> {
  try {
    const cal = await getWorkCalendar(username);
    const today = dayIn(Date.now(), cal.timezone);
    const st = awayStatus(today, cal);
    const next = cal.away.find((p) => p.start > today && daysBetween(today, p.start) <= 14);
    const shape = (p: AwayPeriod) => ({ id: p.id, start: p.start, end: p.end, source: p.source, ...(p.label ? { label: p.label } : {}), ...(p.cover ? { cover: p.cover } : {}) });
    return {
      state: st.state,
      today,
      ...(st.state === "non-working" ? { reason: st.reason } : {}),
      ...(st.state === "away" ? { period: shape(st.period), returnDay: st.returnDay } : {}),
      ...(st.state === "back" ? { period: shape(st.period), redateTo: suggestedRedateDay(today, cal) } : {}),
      ...(next ? { upcoming: { start: next.start, end: next.end, ...(next.label ? { label: next.label } : {}) } } : {}),
    };
  } catch (e) {
    console.warn("[away] today status unavailable:", e instanceof Error ? e.message : e);
    return undefined;
  }
}
