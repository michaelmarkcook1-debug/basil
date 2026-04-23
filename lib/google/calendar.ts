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

export async function createCalendarEvent(params: {
  title: string;
  attendees: string[];
  date: string;       // YYYY-MM-DD
  startTime: string;  // HH:MM
  duration: number;   // minutes
  zoomLink?: string;
}): Promise<{ id: string; htmlLink: string }> {
  const auth = await getAuthedClient();
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

export async function getEventsForMonth(year: number, month: number): Promise<CalendarEvent[]> {
  const auth = await getAuthedClient();
  if (!auth) return [];

  const calendar = google.calendar({ version: "v3", auth });

  const startOfMonth = new Date(year, month, 1);
  const endOfMonth = new Date(year, month + 1, 0, 23, 59, 59);

  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: startOfMonth.toISOString(),
    timeMax: endOfMonth.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 200,
  });

  const now = new Date();
  const todayStr = now.toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const londonToday = new Date(now.toLocaleDateString("en-CA", { timeZone: "Europe/London" }) + "T00:00:00+01:00");
  const tomorrowDate = new Date(londonToday);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr = tomorrowDate.toLocaleDateString("en-CA", { timeZone: "Europe/London" });

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
        timeZone: "Europe/London",
      });
    }
    return mapEvent(e, dateLabel);
  });
}

export async function getTodayEvents(): Promise<CalendarEvent[]> {
  return getEventsForDays(1);
}

/**
 * Return all events on a specific calendar date (YYYY-MM-DD).
 * Uses Europe/London for the day boundary so it matches the user's wall clock.
 */
export async function getEventsForDate(dateStr: string): Promise<CalendarEvent[]> {
  const auth = await getAuthedClient();
  if (!auth) return [];

  const calendar = google.calendar({ version: "v3", auth });

  // Build inclusive day window in London time
  const dayStart = new Date(`${dateStr}T00:00:00`);
  const dayEnd   = new Date(`${dateStr}T23:59:59`);

  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin:     dayStart.toISOString(),
    timeMax:     dayEnd.toISOString(),
    timeZone:    "Europe/London",
    singleEvents: true,
    orderBy:     "startTime",
    maxResults:  50,
  });

  const now = new Date();
  const todayStr    = now.toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const londonToday = new Date(todayStr + "T00:00:00");
  const tomorrowDate = new Date(londonToday);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr = tomorrowDate.toLocaleDateString("en-CA", { timeZone: "Europe/London" });

  return (res.data.items || []).map((e) => {
    const eventDate = (e.start?.dateTime || e.start?.date || "").substring(0, 10);
    let dateLabel: string;
    if (eventDate === todayStr)    dateLabel = "Today";
    else if (eventDate === tomorrowStr) dateLabel = "Tomorrow";
    else {
      dateLabel = new Date(eventDate + "T12:00:00").toLocaleDateString("en-GB", {
        weekday: "long", day: "numeric", month: "long", timeZone: "Europe/London",
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
  startDate: string,
  endDate:   string
): Promise<CalendarEvent[]> {
  const auth = await getAuthedClient();
  if (!auth) return [];

  const calendar = google.calendar({ version: "v3", auth });

  const timeMin = new Date(`${startDate}T00:00:00`);
  const timeMax = new Date(`${endDate}T23:59:59`);

  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin:     timeMin.toISOString(),
    timeMax:     timeMax.toISOString(),
    timeZone:    "Europe/London",
    singleEvents: true,
    orderBy:     "startTime",
    maxResults:  100,
  });

  const now = new Date();
  const todayStr    = now.toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const londonToday = new Date(todayStr + "T00:00:00");
  const tomorrowDate = new Date(londonToday);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr = tomorrowDate.toLocaleDateString("en-CA", { timeZone: "Europe/London" });

  return (res.data.items || []).map((e) => {
    const eventDate = (e.start?.dateTime || e.start?.date || "").substring(0, 10);
    let dateLabel: string;
    if (eventDate === todayStr)    dateLabel = "Today";
    else if (eventDate === tomorrowStr) dateLabel = "Tomorrow";
    else {
      dateLabel = new Date(eventDate + "T12:00:00").toLocaleDateString("en-GB", {
        weekday: "long", day: "numeric", month: "long", timeZone: "Europe/London",
      });
    }
    return mapEvent(e, dateLabel);
  });
}

export async function getEventsForDays(days: number): Promise<CalendarEvent[]> {
  const auth = await getAuthedClient();
  if (!auth) return [];

  const calendar = google.calendar({ version: "v3", auth });

  const now = new Date();
  const londonToday = new Date(now.toLocaleDateString("en-CA", { timeZone: "Europe/London" }) + "T00:00:00+01:00");
  const endDate = new Date(londonToday);
  endDate.setDate(endDate.getDate() + days);

  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: londonToday.toISOString(),
    timeMax: endDate.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 50,
  });

  const todayStr = now.toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const tomorrowDate = new Date(londonToday);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr = tomorrowDate.toLocaleDateString("en-CA", { timeZone: "Europe/London" });

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
        timeZone: "Europe/London",
      });
    }
    return mapEvent(e, dateLabel);
  });
}
