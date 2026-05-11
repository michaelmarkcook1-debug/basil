/**
 * Central date/time utility for Basil.
 * Always use these functions rather than raw Date operations.
 * Default timezone comes from user settings; fallback to Europe/London.
 */

export const DEFAULT_TIMEZONE = "Europe/London";

export function getNow(): Date {
  return new Date();
}

export function formatDate(date: Date | string, timezone = DEFAULT_TIMEZONE): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("en-GB", {
    timeZone: timezone,
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function formatTime(date: Date | string, timezone = DEFAULT_TIMEZONE): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleTimeString("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDateTime(date: Date | string, timezone = DEFAULT_TIMEZONE): string {
  return `${formatDate(date, timezone)} at ${formatTime(date, timezone)}`;
}

export function getTodayRange(timezone = DEFAULT_TIMEZONE): { from: Date; to: Date } {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(now);
  const year  = parseInt(parts.find((p) => p.type === "year")!.value, 10);
  const month = parseInt(parts.find((p) => p.type === "month")!.value, 10) - 1;
  const day   = parseInt(parts.find((p) => p.type === "day")!.value, 10);
  const from  = new Date(Date.UTC(year, month, day, 0, 0, 0));
  const to    = new Date(Date.UTC(year, month, day, 23, 59, 59, 999));
  return { from, to };
}

export function getWeekRange(timezone = DEFAULT_TIMEZONE): { from: Date; to: Date } {
  const today = getTodayRange(timezone);
  const dayOfWeek = today.from.getUTCDay();
  const monday = new Date(today.from);
  monday.setUTCDate(monday.getUTCDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  sunday.setUTCHours(23, 59, 59, 999);
  return { from: monday, to: sunday };
}

export function getSourceWindow(days = 7): { from: Date; to: Date } {
  const to   = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return { from, to };
}

export function relativeLabel(date: Date | string, timezone = DEFAULT_TIMEZONE): string {
  const d      = typeof date === "string" ? new Date(date) : date;
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 0) return "in the future";
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1)  return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7)  return `${diffDays}d ago`;
  return formatDate(d, timezone);
}

/** Format an ISO string for display as a source window label. */
export function windowLabel(from: Date, to: Date, timezone = DEFAULT_TIMEZONE): string {
  return `${formatDate(from, timezone)} – ${formatDate(to, timezone)}`;
}
