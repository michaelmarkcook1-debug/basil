import { google } from "googleapis";
import { getAuthedClient } from "./auth";
import { getSelfIdentity, stripSelf, type SelfIdentity } from "@/lib/self-identity";

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
  location?: string;
  description?: string;
  videoLink?: string;  // extracted meet/zoom/teams join URL
  isOrganizer: boolean;  // true if the authenticated user created/owns this event
  myResponseStatus: "accepted" | "declined" | "tentative" | "needsAction"; // user's RSVP
}

function cleanSummary(summary: string): string {
  // Strip ALL leading emoji characters (Reclaim.ai, Google Calendar, etc.)
  // This catches: pictographs, symbols, dingbats, emoticons, supplemental symbols, skin tones
  return summary
    .replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\u{FE0F}\u{200D}]+\s*/gu, "")
    .replace(/^[✍🍱🛡🆓📌❌✅🔴🟢🟡⭐🔥⏰💡📋🎯]\s*/gu, "")
    .trim();
}

/** Extract a joinable video-call URL from the raw Google Calendar event object. */
function extractVideoLink(e: any): string | undefined { // eslint-disable-line @typescript-eslint/no-explicit-any
  // Google Meet
  if (e.hangoutLink) return e.hangoutLink as string;
  const entryPoints: any[] = e.conferenceData?.entryPoints || []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const video = entryPoints.find((ep: any) => ep.entryPointType === "video"); // eslint-disable-line @typescript-eslint/no-explicit-any
  if (video?.uri) return video.uri as string;
  // Zoom / Teams — scan location and description
  const haystack = `${e.location || ""} ${e.description || ""}`;
  const match = haystack.match(/(https:\/\/[^\s<"]+(?:zoom\.us\/j|teams\.microsoft\.com\/l\/meetup|meet\.google\.com)[^\s<"]*)/i);
  return match?.[1];
}

function mapEvent(
  e: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  dateLabel: string,
  identity: SelfIdentity
): CalendarEvent {
  const isAllDay = !e.start?.dateTime;
  const videoLink = extractVideoLink(e);
  // Strip plain HTML tags from description for clean display
  const rawDesc: string = e.description || "";
  const description = rawDesc
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim()
    .slice(0, 600) || undefined;

  // Strip the user themselves — they are the owner, not an attendee of their own meetings.
  const rawAttendees = (e.attendees || [])
    .map((a: any) => a.displayName || a.email || "") // eslint-disable-line @typescript-eslint/no-explicit-any
    .filter(Boolean);
  const filteredAttendees = stripSelf(rawAttendees, identity);

  // Determine if user is the organizer
  const isOrganizer: boolean = e.organizer?.self === true || !e.organizer; // no organizer field = created by self

  // Find user's own RSVP status from attendees list
  const selfAttendee = (e.attendees || []).find((a: any) => a.self === true); // eslint-disable-line @typescript-eslint/no-explicit-any
  const myResponseStatus: CalendarEvent["myResponseStatus"] =
    selfAttendee?.responseStatus ?? (isOrganizer ? "accepted" : "needsAction");

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
    attendeeCount: filteredAttendees.length,
    attendees: filteredAttendees,
    dateLabel,
    location: e.location || undefined,
    description,
    videoLink,
    isOrganizer,
    myResponseStatus,
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
  const [auth, identity] = await Promise.all([
    getAuthedClient(username),
    getSelfIdentity(username),
  ]);
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
    return mapEvent(e, dateLabel, identity);
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
  const [auth, identity] = await Promise.all([
    getAuthedClient(username),
    getSelfIdentity(username),
  ]);
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
    return mapEvent(e, dateLabel, identity);
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
  const [auth, identity] = await Promise.all([
    getAuthedClient(username),
    getSelfIdentity(username),
  ]);
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
    return mapEvent(e, dateLabel, identity);
  });
}

export async function getEventsForDays(username: string, days: number, timezone = "Europe/London"): Promise<CalendarEvent[]> {
  const [auth, identity] = await Promise.all([
    getAuthedClient(username),
    getSelfIdentity(username),
  ]);
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
    return mapEvent(e, dateLabel, identity);
  });
}

// ── Freebusy ─────────────────────────────────────────────────────────────────

export interface BusyPeriod {
  start: string; // ISO datetime
  end: string;
}

export interface FreeBusyResult {
  email: string;
  busy: BusyPeriod[];
  /** Set when the calendar could not be queried (not shared / no access). */
  error?: string;
}

/**
 * Query Google Calendar's freebusy API for a set of email addresses.
 * Returns each attendee's busy blocks within the given UTC window.
 * Requires that the attendee has shared their calendar with the authenticated user,
 * or that both are on the same Google Workspace that allows freebusy queries.
 */
export async function checkFreeBusy(
  username: string,
  emails: string[],
  timeMin: Date,
  timeMax: Date,
): Promise<FreeBusyResult[]> {
  const auth = await getAuthedClient(username);
  if (!auth) return emails.map((email) => ({ email, busy: [], error: "Not authenticated" }));

  const calendar = google.calendar({ version: "v3", auth });

  try {
    const res = await calendar.freebusy.query({
      requestBody: {
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        items: emails.map((id) => ({ id })),
        timeZone: "UTC",
      },
    });

    return emails.map((email) => {
      const calData = res.data.calendars?.[email];
      if (!calData) return { email, busy: [], error: "Calendar not accessible" };
      const errs = (calData as any).errors; // eslint-disable-line @typescript-eslint/no-explicit-any
      if (errs?.length) return { email, busy: [], error: errs[0].reason ?? "Access denied" };
      return {
        email,
        busy: (calData.busy || []).map((b) => ({
          start: b.start!,
          end: b.end!,
        })),
      };
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return emails.map((email) => ({ email, busy: [], error: msg }));
  }
}

// ── Update / Delete ───────────────────────────────────────────────────────────

export async function updateCalendarEvent(
  username: string,
  eventId: string,
  params: {
    title?: string;
    date?: string;       // YYYY-MM-DD
    startTime?: string;  // HH:MM
    duration?: number;   // minutes
    attendees?: string[];
  },
): Promise<void> {
  const auth = await getAuthedClient(username);
  if (!auth) throw new Error("Google Calendar not connected");

  const calendar = google.calendar({ version: "v3", auth });

  // Fetch existing event to merge fields
  const existing = await calendar.events.get({ calendarId: "primary", eventId });
  const ev = existing.data;

  // Determine the timezone from the existing event (fall back to Europe/London)
  const tz = ev.start?.timeZone || "Europe/London";

  // Build updated start / end if time/date changed
  let startDT = ev.start?.dateTime;
  let endDT   = ev.end?.dateTime;

  if (params.date || params.startTime || params.duration !== undefined) {
    // Extract existing date / time from the event's start dateTime
    const existingStart = new Date(startDT || ev.start?.date || "");
    const existingEnd   = new Date(endDT   || ev.end?.date   || "");
    const existingDuration = Math.round((existingEnd.getTime() - existingStart.getTime()) / 60_000);

    const date     = params.date      || existingStart.toLocaleDateString("en-CA", { timeZone: tz });
    const duration = params.duration  ?? existingDuration;

    let startH: number, startM: number;
    if (params.startTime) {
      [startH, startM] = params.startTime.split(":").map(Number);
    } else {
      const parts = existingStart.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).split(":");
      startH = parseInt(parts[0], 10);
      startM = parseInt(parts[1], 10);
    }

    const totalEndMin  = startH * 60 + startM + duration;
    const endH         = Math.floor(totalEndMin / 60) % 24;
    const endM         = totalEndMin % 60;
    const dayOffset    = Math.floor(totalEndMin / (60 * 24));

    const endDateObj = new Date(`${date}T00:00:00Z`);
    endDateObj.setUTCDate(endDateObj.getUTCDate() + dayOffset);
    const endDateStr = endDateObj.toISOString().slice(0, 10);

    startDT = `${date}T${String(startH).padStart(2,"0")}:${String(startM).padStart(2,"0")}:00`;
    endDT   = `${endDateStr}T${String(endH).padStart(2,"0")}:${String(endM).padStart(2,"0")}:00`;
  }

  await calendar.events.patch({
    calendarId: "primary",
    eventId,
    requestBody: {
      ...(params.title     ? { summary: params.title } : {}),
      ...(startDT          ? { start: { dateTime: startDT, timeZone: tz } } : {}),
      ...(endDT            ? { end:   { dateTime: endDT,   timeZone: tz } } : {}),
      ...(params.attendees ? { attendees: params.attendees.map((email) => ({ email })) } : {}),
    },
  });
}

export async function deleteCalendarEvent(username: string, eventId: string): Promise<void> {
  const auth = await getAuthedClient(username);
  if (!auth) throw new Error("Google Calendar not connected");
  const calendar = google.calendar({ version: "v3", auth });
  await calendar.events.delete({ calendarId: "primary", eventId });
}
