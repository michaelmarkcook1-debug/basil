/**
 * Calendar-day helpers for the dashboard pages.
 *
 * Several pages worked out "today" as `new Date().toISOString().split("T")[0]`,
 * which is the UTC date: for a user in New York every evening after 19:00 is
 * "tomorrow", so actions due today read as overdue and "Today" groups the wrong
 * items. A date-only due date ("2026-11-12") parsed with `new Date()` is UTC
 * midnight, so west of London it rendered a day early.
 *
 * Everything here is pure (no React, no fetch) so the tests can run it.
 */

/** True when `tz` is an IANA zone this runtime understands. */
export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz || typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** True for a bare calendar date such as "2026-11-12" (no time, no zone). */
export function isDateOnly(value: string | null | undefined): value is string {
  return typeof value === "string" && DATE_ONLY.test(value);
}

/**
 * "YYYY-MM-DD" for the instant `at` as seen in `timeZone` — the user's
 * settings timezone. Falls back to the browser's zone when it is missing or
 * invalid. Returns "" for an unparseable date.
 */
export function dayInZone(at: Date | string | number = new Date(), timeZone?: string | null): string {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const opts: Intl.DateTimeFormatOptions = { year: "numeric", month: "2-digit", day: "2-digit" };
  if (isValidTimeZone(timeZone)) opts.timeZone = timeZone;
  return new Intl.DateTimeFormat("en-CA", opts).format(d);
}

/** Calendar arithmetic on "YYYY-MM-DD" (no DST or UTC drift). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Today + n as a calendar day in `timeZone` (e.g. "Push → Tomorrow"). */
export function daysFromToday(n: number, timeZone?: string | null, now: Date = new Date()): string {
  return addDays(dayInZone(now, timeZone), n);
}

/**
 * The calendar day an action/decision is due. A date-only value IS the day;
 * a full timestamp is converted to the user's zone.
 */
export function dueDayOf(due: string | null | undefined, timeZone?: string | null): string {
  if (!due) return "";
  if (isDateOnly(due)) return due;
  return dayInZone(due, timeZone);
}

/**
 * Format a calendar day for display without shifting it through UTC midnight.
 * `formatDay("2026-11-12", { weekday: "short", day: "numeric", month: "short" })`
 * is "Thu 12 Nov" in every timezone.
 */
export function formatDay(day: string, opts: Intl.DateTimeFormatOptions, locale = "en-GB"): string {
  if (!isDateOnly(day)) return "";
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(locale, { ...opts, timeZone: "UTC" });
}

/** Display a due date (date-only or timestamp) as a calendar day in the user's zone. */
export function formatDueDay(due: string, timeZone: string | null | undefined, opts: Intl.DateTimeFormatOptions, locale = "en-GB"): string {
  return formatDay(dueDayOf(due, timeZone), opts, locale);
}

/**
 * "YYYY-MM-DD" from a Date's LOCAL getters — for pickers whose time is also
 * local (e.g. the day view's slot picker). `toISOString()` would give the UTC
 * day, which in the Americas in the evening is already tomorrow.
 */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
