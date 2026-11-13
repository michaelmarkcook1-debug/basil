/**
 * The user's working calendar: which days they work, which are bank holidays,
 * and when they are away. Pure — no server imports — so Today, the briefing,
 * the follow-up clocks and the action rules all read the same answer.
 *
 * Before 2026-11-10 Basil treated all 365 days alike: the briefing was written
 * and emailed on Saturdays, on Christmas Day and through a two-week honeymoon;
 * an unanswered message turned "critical" over a weekend; Today greeted an
 * out-of-office user with "8½ h free to think". Tested in tests/away-mode.test.mjs.
 */

export type HolidayRegion = "england-and-wales" | "scotland" | "northern-ireland" | "none";
export const HOLIDAY_REGIONS: HolidayRegion[] = ["england-and-wales", "scotland", "northern-ireland", "none"];

/** A stretch of days the user is not working (leave). Days are YYYY-MM-DD, both inclusive. */
export interface AwayPeriod {
  id: string;
  start: string;
  end: string;
  /** "calendar": an out-of-office block on Google Calendar. "basil": told to Basil. */
  source: "calendar" | "basil";
  label?: string;
  /** Who is covering, as the user wrote it. */
  cover?: string;
}

export interface WorkCalendar {
  timezone: string;
  /** 0 = Sunday … 6 = Saturday. */
  workingDays: number[];
  holidayRegion: HolidayRegion;
  away: AwayPeriod[];
}

export const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5];

/** UK users get their bank holidays by default; anyone else has none until they choose. */
export function defaultHolidayRegion(timezone: string): HolidayRegion {
  return timezone === "Europe/London" ? "england-and-wales" : "none";
}

// ── Days ─────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDay(s: unknown): s is string {
  return typeof s === "string" && ISO_DAY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

/** YYYY-MM-DD of instant `ms` in `tz`. */
export function dayIn(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(day: string): number {
  return new Date(`${day}T12:00:00Z`).getUTCDay();
}

/** Whole days from `a` to `b` (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

function tzOffsetMs(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - ms;
}

/** Epoch ms of 00:00 on `day` in `tz` (correct on clock-change days). */
export function midnightIn(day: string, tz: string): number {
  const guess = Date.parse(`${day}T00:00:00Z`);
  const first = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(first, tz);
}

// ── Bank holidays ────────────────────────────────────────────────────────────

/**
 * The official lists, read from https://www.gov.uk/bank-holidays.json on
 * 2026-11-10. They include one-offs no rule can predict (Scotland's 15 June
 * 2026). Years outside this table fall back to the rules below, which
 * reproduce every regular holiday in it.
 */
const OFFICIAL: Record<Exclude<HolidayRegion, "none">, string[]> = {
  "england-and-wales": [
    "2025-01-01", "2025-04-18", "2025-04-21", "2025-05-05", "2025-05-26", "2025-08-25", "2025-12-25", "2025-12-26",
    "2026-01-01", "2026-04-03", "2026-04-06", "2026-05-04", "2026-05-25", "2026-08-31", "2026-12-25", "2026-12-28",
    "2027-01-01", "2027-03-26", "2027-03-29", "2027-05-03", "2027-05-31", "2027-08-30", "2027-12-27", "2027-12-28",
    "2028-01-03", "2028-04-14", "2028-04-17", "2028-05-01", "2028-05-29", "2028-08-28", "2028-12-25", "2028-12-26",
  ],
  scotland: [
    "2025-01-01", "2025-01-02", "2025-04-18", "2025-05-05", "2025-05-26", "2025-08-04", "2025-12-01", "2025-12-25", "2025-12-26",
    "2026-01-01", "2026-01-02", "2026-04-03", "2026-05-04", "2026-05-25", "2026-06-15", "2026-08-03", "2026-11-30", "2026-12-25", "2026-12-28",
    "2027-01-01", "2027-01-04", "2027-03-26", "2027-05-03", "2027-05-31", "2027-08-02", "2027-11-30", "2027-12-27", "2027-12-28",
    "2028-01-03", "2028-01-04", "2028-04-14", "2028-05-01", "2028-05-29", "2028-08-07", "2028-11-30", "2028-12-25", "2028-12-26",
  ],
  "northern-ireland": [
    "2025-01-01", "2025-03-17", "2025-04-18", "2025-04-21", "2025-05-05", "2025-05-26", "2025-07-14", "2025-08-25", "2025-12-25", "2025-12-26",
    "2026-01-01", "2026-03-17", "2026-04-03", "2026-04-06", "2026-05-04", "2026-05-25", "2026-07-13", "2026-08-31", "2026-12-25", "2026-12-28",
    "2027-01-01", "2027-03-17", "2027-03-26", "2027-03-29", "2027-05-03", "2027-05-31", "2027-07-12", "2027-08-30", "2027-12-27", "2027-12-28",
    "2028-01-03", "2028-03-17", "2028-04-14", "2028-04-17", "2028-05-01", "2028-05-29", "2028-07-12", "2028-08-28", "2028-12-25", "2028-12-26",
  ],
};
const OFFICIAL_FIRST_YEAR = 2025;
const OFFICIAL_LAST_YEAR = 2028;

/** Easter Sunday (anonymous Gregorian algorithm). */
function easterSunday(year: number): string {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function firstMonday(year: number, month: number): string {
  let d = `${year}-${String(month).padStart(2, "0")}-01`;
  while (weekdayOf(d) !== 1) d = addDays(d, 1);
  return d;
}

function lastMonday(year: number, month: number): string {
  let d = addDays(month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`, -1);
  while (weekdayOf(d) !== 1) d = addDays(d, -1);
  return d;
}

/** Fixed-date holidays falling on a weekend move to the next free weekday, in order. */
function withSubstitutes(fixed: string[]): string[] {
  const taken = new Set<string>();
  for (const d of fixed) {
    let day = d;
    while (weekdayOf(day) === 0 || weekdayOf(day) === 6 || taken.has(day)) day = addDays(day, 1);
    taken.add(day);
  }
  return [...taken];
}

function ruleBasedHolidays(region: Exclude<HolidayRegion, "none">, year: number): string[] {
  const easter = easterSunday(year);
  const y = String(year);
  const days: string[] = [addDays(easter, -2), firstMonday(year, 5), lastMonday(year, 5)];
  if (region !== "scotland") days.push(addDays(easter, 1));
  days.push(region === "scotland" ? firstMonday(year, 8) : lastMonday(year, 8));
  const newYear = region === "scotland" ? withSubstitutes([`${y}-01-01`, `${y}-01-02`]) : withSubstitutes([`${y}-01-01`]);
  const extras =
    region === "scotland" ? withSubstitutes([`${y}-11-30`]) :
    region === "northern-ireland" ? [...withSubstitutes([`${y}-03-17`]), ...withSubstitutes([`${y}-07-12`])] : [];
  return [...newYear, ...days, ...extras, ...withSubstitutes([`${y}-12-25`, `${y}-12-26`])].sort();
}

const holidayCache = new Map<string, Set<string>>();

/** Bank holidays in `region` for `year`, as YYYY-MM-DD. */
export function bankHolidays(region: HolidayRegion, year: number): string[] {
  if (region === "none") return [];
  if (year >= OFFICIAL_FIRST_YEAR && year <= OFFICIAL_LAST_YEAR) return OFFICIAL[region].filter((d) => d.startsWith(`${year}-`));
  return ruleBasedHolidays(region, year);
}

/** Exported for tests: the rules alone, without the official table. */
export const __ruleBasedHolidays = ruleBasedHolidays;

export function isBankHoliday(day: string, region: HolidayRegion): boolean {
  if (region === "none") return false;
  const key = `${region}:${day.slice(0, 4)}`;
  let set = holidayCache.get(key);
  if (!set) {
    set = new Set(bankHolidays(region, Number(day.slice(0, 4))));
    holidayCache.set(key, set);
  }
  return set.has(day);
}

// ── Working days and absence ─────────────────────────────────────────────────

/** The away period covering `day`, if any. */
export function awayOn(day: string, cal: WorkCalendar): AwayPeriod | undefined {
  return cal.away.find((p) => p.start <= day && day <= p.end);
}

/** A day the user normally works: a working weekday that is not a bank holiday. Ignores absence. */
export function isWorkingDay(day: string, cal: WorkCalendar): boolean {
  return cal.workingDays.includes(weekdayOf(day)) && !isBankHoliday(day, cal.holidayRegion);
}

/** A working day on which the user is not away. */
export function isAvailableDay(day: string, cal: WorkCalendar): boolean {
  return isWorkingDay(day, cal) && !awayOn(day, cal);
}

/** Bounded so a misconfigured calendar (no working days) cannot loop forever. */
const SEARCH_LIMIT_DAYS = 400;

export function previousAvailableDay(day: string, cal: WorkCalendar): string {
  let d = addDays(day, -1);
  for (let i = 0; i < SEARCH_LIMIT_DAYS && !isAvailableDay(d, cal); i++) d = addDays(d, -1);
  return d;
}

export function nextAvailableDay(day: string, cal: WorkCalendar): string {
  let d = addDays(day, 1);
  for (let i = 0; i < SEARCH_LIMIT_DAYS && !isAvailableDay(d, cal); i++) d = addDays(d, 1);
  return d;
}

/** Away days in [fromDay, toDay). With `nonWorking`, weekends and bank holidays count too. */
export function pausedDays(fromDay: string, toDay: string, cal: WorkCalendar, opts: { nonWorking?: boolean } = {}): number {
  let n = 0;
  let d = fromDay;
  for (let i = 0; i < SEARCH_LIMIT_DAYS * 3 && d < toDay; i++, d = addDays(d, 1)) {
    if (awayOn(d, cal) || (opts.nonWorking && !isWorkingDay(d, cal))) n++;
  }
  return n;
}

/**
 * Hours between two instants that fell on days the user was working and not
 * away. A message left on Friday afternoon has waited a few hours by Monday
 * morning, not three days; one left before a fortnight's leave has waited
 * since the day the user came back.
 */
export function workingHoursBetween(fromMs: number, toMs: number, cal: WorkCalendar): number {
  if (!(toMs > fromMs)) return 0;
  let total = 0;
  let day = dayIn(fromMs, cal.timezone);
  const lastDay = dayIn(toMs, cal.timezone);
  for (let i = 0; i < SEARCH_LIMIT_DAYS * 3; i++) {
    if (isAvailableDay(day, cal)) {
      const start = midnightIn(day, cal.timezone);
      const end = midnightIn(addDays(day, 1), cal.timezone);
      total += Math.max(0, Math.min(end, toMs) - Math.max(start, fromMs));
    }
    if (day >= lastDay) break;
    day = addDays(day, 1);
  }
  return total / 3_600_000;
}

export type AwayStatus =
  | { state: "working"; today: string; since: string }
  | { state: "non-working"; today: string; reason: "weekend" | "bank-holiday" }
  | { state: "away"; today: string; period: AwayPeriod; returnDay: string }
  | { state: "back"; today: string; period: AwayPeriod; since: string };

/**
 * Where the user stands today.
 *   away        — a leave day: no briefing, clocks paused, Today shows the away card
 *   non-working — a weekend or bank holiday: no briefing
 *   back        — the first working day after an absence: the briefing covers all of it
 *   working     — an ordinary day; `since` is the start of the previous working day,
 *                 so Monday's briefing covers the weekend
 */
export function awayStatus(today: string, cal: WorkCalendar): AwayStatus {
  const period = awayOn(today, cal);
  if (period) {
    // The return day is the next working day after the WHOLE absence, even
    // when two periods sit back to back.
    return { state: "away", today, period, returnDay: nextAvailableDay(today, cal) };
  }
  if (!isWorkingDay(today, cal)) {
    return { state: "non-working", today, reason: isBankHoliday(today, cal.holidayRegion) ? "bank-holiday" : "weekend" };
  }
  const since = previousAvailableDay(today, cal);
  const absence = cal.away
    .filter((p) => p.end < today && p.end >= since)
    .sort((a, b) => (a.end < b.end ? 1 : -1))[0];
  if (absence) return { state: "back", today, period: absence, since };
  return { state: "working", today, since };
}

// ── Reading absence from Google Calendar ─────────────────────────────────────

/** Titles people give an all-day block when they are off. */
const LEAVE_TITLE = /\b(out of (the )?office|ooo|annual leave|on leave|holiday|vacation|pto|time off|parental leave|maternity leave|paternity leave|honeymoon|sick)\b/i;

/** At least this long for a timed out-of-office block to count as a day off. */
const MIN_OOO_HOURS = 20;

interface RawEvent {
  id?: string | null;
  summary?: string | null;
  eventType?: string | null;
  status?: string | null;
  start?: { date?: string | null; dateTime?: string | null } | null;
  end?: { date?: string | null; dateTime?: string | null } | null;
  organizer?: { self?: boolean | null } | null;
  attendees?: Array<{ self?: boolean | null }> | null;
}

/**
 * Leave periods from raw Google Calendar events.
 *   • Out-of-office events (Google's own type, or the ones Basil creates) that
 *     run most of a day or longer.
 *   • The user's own all-day events titled like leave ("Annual leave", "OOO").
 *     Someone else's invite titled "Ed — holiday" is about Ed, so only events
 *     the user organised, or that have no other guests, count.
 * A few hours out of office is not a day off and is ignored.
 */
export function awayPeriodsFromEvents(events: RawEvent[], tz: string): AwayPeriod[] {
  const out: AwayPeriod[] = [];
  for (const e of events) {
    if (e.status === "cancelled") continue;
    const allDay = !e.start?.dateTime && !!e.start?.date && !!e.end?.date;
    const own = e.organizer?.self === true || (e.attendees ?? []).filter((a) => !a.self).length === 0;
    const ooo = e.eventType === "outOfOffice";
    const titled = allDay && own && LEAVE_TITLE.test(e.summary ?? "");
    if (!ooo && !titled) continue;

    let start: string, end: string;
    if (allDay) {
      start = e.start!.date!;
      end = addDays(e.end!.date!, -1); // Google's all-day end is exclusive
    } else {
      const s = Date.parse(e.start?.dateTime ?? "");
      const f = Date.parse(e.end?.dateTime ?? "");
      if (!Number.isFinite(s) || !Number.isFinite(f) || (f - s) / 3_600_000 < MIN_OOO_HOURS) continue;
      start = dayIn(s, tz);
      end = dayIn(f - 1, tz);
    }
    if (!isIsoDay(start) || !isIsoDay(end) || end < start) continue;
    out.push({ id: `cal:${e.id ?? `${start}-${end}`}`, start, end, source: "calendar", label: (e.summary ?? "").trim() || "Out of office" });
  }
  return out;
}

/** True when a mapped calendar event is an absence rather than a meeting. */
export function isAbsenceEvent(e: { eventType?: string; summary?: string; isAllDay?: boolean; attendeeCount?: number }): boolean {
  if (e.eventType === "outOfOffice") return true;
  return !!e.isAllDay && (e.attendeeCount ?? 0) === 0 && LEAVE_TITLE.test(e.summary ?? "");
}

/** "Fri 13 Nov" for a YYYY-MM-DD. */
export function shortDay(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}
