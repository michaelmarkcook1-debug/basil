/**
 * Timezone resolution and date utilities.
 *
 * Single source of truth for all date/time operations in Basil.
 *
 * When a user has opted in to IP-based timezone detection (useIpTimezone = true),
 * Basil reads the `x-vercel-ip-timezone` header that Vercel injects automatically
 * on every request from its Edge Network — no third-party lookup needed.
 *
 * Falls back to the stored settings timezone if the header is absent or invalid.
 *
 * IMPORTANT: Never use new Date().toISOString().slice(0,10) for "today" —
 * that gives UTC date which can be off by a day from the user's timezone.
 * Always use getTodayISO(tz) or formatInTimezone(date, tz, format) instead.
 */

/**
 * Validates that a string is a recognised IANA timezone identifier.
 * Uses Intl — safe in both Node.js and browser environments.
 */
function isValidIANA(tz: string): boolean {
  if (!tz || typeof tz !== "string") return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract the Vercel-injected IP timezone from request headers.
 * Returns null if not present or not a valid IANA identifier.
 */
export function getIpTimezone(req: Request): string | null {
  const tz = req.headers.get("x-vercel-ip-timezone");
  if (tz && isValidIANA(tz)) return tz;
  return null;
}

/**
 * Resolve the effective timezone for a request.
 *
 * - If `useIpTimezone` is true and the Vercel header provides a valid timezone, use it.
 * - Otherwise fall back to the user's stored `settings.timezone`.
 * - As a final fallback, use "UTC".
 */
export function resolveTimezone(
  settings: { timezone: string; useIpTimezone?: boolean },
  req?: Request,
): string {
  if (settings.useIpTimezone && req) {
    const ipTz = getIpTimezone(req);
    if (ipTz) return ipTz;
  }
  return settings.timezone || "Europe/London";
}

// ── Date helpers ───────────────────────────────────────────────────────────────

/** Default user timezone when not explicitly configured. */
export const DEFAULT_TIMEZONE = "Europe/London";

/**
 * Returns today's date as "YYYY-MM-DD" in the given timezone.
 * Safe to call server-side or client-side.
 *
 * @example getTodayISO("Europe/London") // "2026-05-10"
 */
export function getTodayISO(tz = DEFAULT_TIMEZONE): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: tz });
}

/**
 * Returns the current time as an ISO string adjusted to the user's timezone context.
 * The Date object is still UTC; formatting will reflect the timezone.
 */
export function getNow(): Date {
  return new Date();
}

/**
 * Returns a human-readable "Today: Weekday, DD Month YYYY" string.
 * Used in headings on Schedule, Briefing etc.
 */
export function getTodayLabel(tz = DEFAULT_TIMEZONE): string {
  return new Date().toLocaleDateString("en-GB", {
    timeZone: tz,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/**
 * Returns start and end of the current week (Mon–Sun) as ISO date strings
 * in the given timezone.
 */
export function getWeekRangeISO(tz = DEFAULT_TIMEZONE): { start: string; end: string } {
  const now = new Date();
  const todayStr = now.toLocaleDateString("en-CA", { timeZone: tz }); // "YYYY-MM-DD"
  const today = new Date(todayStr + "T12:00:00Z"); // Noon UTC on local date avoids DST edge cases

  const dow = today.getDay(); // 0=Sun, 1=Mon, …
  const daysFromMon = (dow + 6) % 7; // Mon=0, Tue=1, …, Sun=6
  const monday = new Date(today);
  monday.setUTCDate(today.getUTCDate() - daysFromMon);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);

  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { start: fmt(monday), end: fmt(sunday) };
}

/**
 * Returns true if an ISO date string (YYYY-MM-DD) falls on today in the
 * given timezone.
 */
export function isToday(isoDate: string, tz = DEFAULT_TIMEZONE): boolean {
  return isoDate === getTodayISO(tz);
}

/**
 * Returns true if an ISO date string is in the past (before today) in the
 * given timezone.
 */
export function isPast(isoDate: string, tz = DEFAULT_TIMEZONE): boolean {
  return isoDate < getTodayISO(tz);
}

/**
 * Format a Date or ISO string for display in the user's timezone.
 * Returns a short "10 May" style string.
 */
export function formatShortDate(date: Date | string, tz = DEFAULT_TIMEZONE): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("en-GB", { timeZone: tz, day: "numeric", month: "short" });
}

/**
 * Format a Date or ISO string as a full date + time for display.
 */
export function formatDateTime(date: Date | string, tz = DEFAULT_TIMEZONE): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString("en-GB", { timeZone: tz, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
