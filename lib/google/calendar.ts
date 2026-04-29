import { google } from "googleapis";
import { getAuthedClient } from "./auth";
import { stripSelf } from "@/lib/self-identity";

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  isAllDay: boolean;
  hasVideo: boolean;
  attendeeCount: number;
  attendees: string[];
  dateLabel?: string; // "Today", "Tomorrow", or "Wednesday, 16 April"
}

function cleanSummary(summary: string): string {
  // Strip ALL leading emoji characters (Reclaim.ai, Google Calendar, etc.)
  // This catches: pictographs, symbols, dingbats, emoticons, supplemental symbols, skin tones
  return summary
    .replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\u{FE0F}\u{200D}]+\s*/gu, "")
    .replace(/^[✍🍱🛡🆓📌❌✅🔴🟢🟡⭐🔥⏰💡📋🎯]\s*/gu, "")
    .trim();
}

function mapEvent(e: any, dateLabel: string): CalendarEvent { // eslint-disable-line @typescript-eslint/no-explicit-any
  const isAllDay = !e.start?.dateTime;
  return {
    id: e.id || "",
    summary: cleanSummary(e.summary || "Untitled"),
    start: e.start?.dateTime || e.start?.date || "",
    end: e.end?.dateTime || e.end?.date || "",
    isAllDay,
    hasVideo: !!(
      e.conferenceData ||
      e.hangoutLink ||
      (e.description || "").toLowerCase().includes("zoom") ||
      (e.location || "").toLowerCase().includes("zoom")
    ),
    // Strip Michael himself — he's the user, not an attendee of his own meetings.
    attendeeCount: stripSelf(
      (e.attendees || [])
        .map((a: any) => a.displayName || a.email || "") // eslint-disable-line @typescript-eslint/no-explicit-any
        .filter(Boolean)
    ).length,
    attendees: stripSelf(
      (e.attendees || [])
        .map((a: any) => a.displayName || a.email || "") // eslint-disable-line @typescript-eslint/no-explicit-any
        .filter(Boolean)
    ),
    dateLabel,
  };
}

export async function createCalendarEvent(username: string, params: {
  title: string;
  attendees: string[];
  date: string;       // YYYY-MM-DD
  startTime: string;  // HH:MM
  duration: number;   // minutes
  zoomLink?: string;
}): Promise<{ id: string; htmlLink: string }> {
  const auth = await getAuthedClient(username);
  if (!auth) throw new Error("Google Calendar not connected");

  const calendar = google.calendar({ version: "v3", auth });

  const zoom =
    params.zoomLink ||
    "https://us06web.zoom.us/j/8588489477?pwd=p5SrgLfrDLBXKCvbFOFGGfMaoQ1MkI.1";

  // Compute start + end as naive wall-clock strings and let Google interpret
  // them in Europe/London (handles BST/GMT transitions correctly).
  const [sh, sm] = params.startTime.split(":").map((n) => parseInt(n, 10));
  const totalStartMin = sh * 60 + sm;
  const totalEndMin = totalStartMin + params.duration;
  const endHours = Math.floor(totalEndMin / 60);
  const endMins = totalEndMin % 60;

  // If duration crosses midnight, roll the end date forward by the day delta.
  const dayOffset = Math.floor(endHours / 24);
  const endHourInDay = endHours % 24;

  const startDateTime = `${params.date}T${String(sh).padStart(2, "0")}:${String(sm).padStart(2, "0")}:00`;
  const endDate = new Date(`${params.date}T00:00:00Z`);
  endDate.setUTCDate(endDate.getUTCDate() + dayOffset);
  const endDateStr = endDate.toISOString().slice(0, 10);
  const endDateTime = `${endDateStr}T${String(endHourInDay).padStart(2, "0")}:${String(endMins).padStart(2, "0")}:00`;

  const res = await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      summary: params.title,
      location: zoom,
      description: `Zoom: ${zoom}`,
      start: {
        dateTime: startDateTime,
        timeZone: "Europe/London",
      },
      end: {
        dateTime: endDateTime,
        timeZone: "Europe/London",
      },
      attendees: params.attendees.map((email) => ({ email })),
    },
  });

  return {
    id: res.data.id || "",
    htmlLink: res.data.htmlLink || "",
  };
}

export async function getEventsForMonth(
  username: string,
  year: number,
  month: number,
  timezone = "Europe/London",
): Promise<CalendarEvent[]> {
  const auth = await getAuthedClient(username);
  if (!auth) return [];

  const calendar = google.calendar({ version: "v3", auth });

  // Use timezone-aware day bounds for the first and last day of the month
  const firstDay = `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const lastDayDate = new Date(year, month + 1, 0);
  const lastDay = `${year}-${String(month + 1).padStart(2, "0")}-${String(lastDayDate.getDate()).padStart(2, "0")}`;
  const { start: startOfMonth } = tzDayBounds(firstDay, timezone);
  const { end:   endOfMonth   } = tzDayBounds(lastDay,  timezone);

  // Paginate through all results — a busy month easily exceeds 200 events
  // (recurring "Focus time", Lunch, standups, etc.) so a single-page fetch
  // silently drops events near month-end.
  const allItems: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  let pageToken: string | undefined;
  do {
    const res = await calendar.events.list({
      calendarId: "primary",
      timeMin: startOfMonth.toISOString(),
      timeMax: endOfMonth.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 250,
      ...(pageToken ? { pageToken } : {}),
    });
    allItems.push(...(res.data.items || []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  const now = new Date();
  const todayStr    = now.toLocaleDateString("en-CA", { timeZone: timezone });
  const { start: tzToday } = tzDayBounds(todayStr, timezone);
  const tomorrowDate = new Date(tzToday);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr = tomorrowDate.toLocaleDateString("en-CA", { timeZone: timezone });

  return allItems.map((e) => {
    const eventDate = (e.start?.dateTime || e.start?.date || "").substring(0, 10);
    let dateLabel: string;
    if (eventDate === todayStr) {
      dateLabel = "Today";
    } else if (eventDate === tomorrowStr) {
      dateLabel = "Tomorrow";
    } else {
      dateLabel = new Date(eventDate + "T12:00:00").toLocaleDateString("en-GB", {
        weekday: "long",
        day: "numeric",
        month: "long",
        timeZone: timezone,
      });
    }
    return mapEvent(e, dateLabel);
  });
}

export async function getTodayEvents(username: string, timezone = "Europe/London"): Promise<CalendarEvent[]> {
  return getEventsForDays(username, 1, timezone);
}

/**
 * Return all events on a specific calendar date (YYYY-MM-DD).
 * Uses Europe/London for the day boundary so it matches the user's wall clock.
 */
/** Returns the UTC offset in hours for a given timezone + date (e.g. +1 for BST, -5 for EST). */
function tzOffsetHours(date: Date, timeZone: string): number {
  const utcMs = new Date(date.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
  const tzMs  = new Date(date.toLocaleString("en-US", { timeZone })).getTime();
  return (tzMs - utcMs) / 3_600_000;
}

/**
 * Build a Date representing midnight (start) and 23:59:59 (end) in the given
 * IANA timezone for a YYYY-MM-DD string.  Handles DST transitions correctly.
 */
function tzDayBounds(dateStr: string, timeZone: string): { start: Date; end: Date } {
  const noon      = new Date(`${dateStr}T12:00:00Z`); // use noon UTC as stable DST reference
  const offsetH   = tzOffsetHours(noon, timeZone);
  const sign      = offsetH >= 0 ? "+" : "-";
  const absH      = Math.abs(offsetH);
  const hh        = String(Math.floor(absH)).padStart(2, "0");
  const mm        = String(Math.round((absH % 1) * 60)).padStart(2, "0");
  const offsetStr = `${sign}${hh}:${mm}`;
  return {
    start: new Date(`${dateStr}T00:00:00${offsetStr}`),
    end:   new Date(`${dateStr}T23:59:59${offsetStr}`),
  };
}

export async function getEventsForDate(
  username: string,
  dateStr: string,
  timezone = "Europe/London",
): Promise<CalendarEvent[]> {
  const auth = await getAuthedClient(username);
  if (!auth) return [];

  const calendar = google.calendar({ version: "v3", auth });

  // Midnight-to-midnight boundaries in the user's actual timezone
  const { start: dayStart, end: dayEnd } = tzDayBounds(dateStr, timezone);

  const res = await calendar.events.list({
    calendarId:   "primary",
    timeMin:      dayStart.toISOString(),
    timeMax:      dayEnd.toISOString(),
    timeZone:     timezone,
    singleEvents: true,
    orderBy:      "startTime",
    maxResults:   50,
  });

  const now = new Date();
  const todayStr    = now.toLocaleDateString("en-CA", { timeZone: timezone });
  const { start: tzToday } = tzDayBounds(todayStr, timezone);
  const tomorrowDate = new Date(tzToday);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr = tomorrowDate.toLocaleDateString("en-CA", { timeZone: timezone });

  return (res.data.items || []).map((e) => {
    const eventDate = (e.start?.dateTime || e.start?.date || "").substring(0, 10);
    let dateLabel: string;
    if (eventDate === todayStr)          dateLabel = "Today";
    else if (eventDate === tomorrowStr)  dateLabel = "Tomorrow";
    else {
      dateLabel = new Date(eventDate + "T12:00:00").toLocaleDateString("en-GB", {
        weekday: "long", day: "numeric", month: "long", timeZone: timezone,
      });
    }
    return mapEvent(e, dateLabel);
  });
}

/**
 * Return events across an inclusive date range (both dates YYYY-MM-DD).
 * Maximum 100 results, ordered by start time.
 */
export async function getEventsForDateRange(
  username: string,
  startDate: string,
  endDate:   string,
  timezone = "Europe/London",
): Promise<CalendarEvent[]> {
  const auth = await getAuthedClient(username);
  if (!auth) return [];

  const calendar = google.calendar({ version: "v3", auth });

  const { start: timeMin } = tzDayBounds(startDate, timezone);
  const { end:   timeMax } = tzDayBounds(endDate,   timezone);

  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin:     timeMin.toISOString(),
    timeMax:     timeMax.toISOString(),
    timeZone:    timezone,
    singleEvents: true,
    orderBy:     "startTime",
    maxResults:  100,
  });

  const now = new Date();
  const todayStr    = now.toLocaleDateString("en-CA", { timeZone: timezone });
  const { start: tzToday } = tzDayBounds(todayStr, timezone);
  const tomorrowDate = new Date(tzToday);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr = tomorrowDate.toLocaleDateString("en-CA", { timeZone: timezone });

  return (res.data.items || []).map((e) => {
    const eventDate = (e.start?.dateTime || e.start?.date || "").substring(0, 10);
    let dateLabel: string;
    if (eventDate === todayStr)    dateLabel = "Today";
    else if (eventDate === tomorrowStr) dateLabel = "Tomorrow";
    else {
      dateLabel = new Date(eventDate + "T12:00:00").toLocaleDateString("en-GB", {
        weekday: "long", day: "numeric", month: "long", timeZone: timezone,
      });
    }
    return mapEvent(e, dateLabel);
  });
}

export async function getEventsForDays(username: string, days: number, timezone = "Europe/London"): Promise<CalendarEvent[]> {
  const auth = await getAuthedClient(username);
  if (!auth) return [];

  const calendar = google.calendar({ version: "v3", auth });

  const now = new Date();
  const todayDateStr = now.toLocaleDateString("en-CA", { timeZone: timezone });
  const { start: tzToday } = tzDayBounds(todayDateStr, timezone);
  const endDate = new Date(tzToday);
  endDate.setDate(endDate.getDate() + days);

  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: tzToday.toISOString(),
    timeMax: endDate.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 200,
  });

  const todayStr = now.toLocaleDateString("en-CA", { timeZone: timezone });
  const tomorrowDate = new Date(tzToday);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr = tomorrowDate.toLocaleDateString("en-CA", { timeZone: timezone });

  return (res.data.items || []).map((e) => {
    const eventDate = (e.start?.dateTime || e.start?.date || "").substring(0, 10);
    let dateLabel: string;
    if (eventDate === todayStr) {
      dateLabel = "Today";
    } else if (eventDate === tomorrowStr) {
      dateLabel = "Tomorrow";
    } else {
      dateLabel = new Date(eventDate + "T12:00:00").toLocaleDateString("en-GB", {
        weekday: "long",
        day: "numeric",
        month: "long",
        timeZone: timezone,
      });
    }
    return mapEvent(e, dateLabel);
  });
}
