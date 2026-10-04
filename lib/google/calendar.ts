import { google } from "googleapis";
import { getAuthedClient } from "./auth";
import { getSelfIdentity, stripSelf, type SelfIdentity } from "@/lib/self-identity";
import { sendEmail } from "./gmail";

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
  /** Who sent the invitation — addressee for a proposed new time. */
  organizerName?: string;
  organizerEmail?: string;
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
    organizerName: e.organizer?.displayName || undefined,
    organizerEmail: e.organizer?.email || undefined,
  };
}

export async function createCalendarEvent(username: string, params: {
  title: string;
  attendees: string[];
  date: string;       // YYYY-MM-DD
  startTime: string;  // HH:MM
  duration: number;   // minutes
  /**
   * Optional explicit conference URL (e.g. a personal Zoom room) the user
   * pasted into the New Event form. When set, it is used verbatim as the
   * event location + description prefix.
   */
  zoomLink?: string;
  /**
   * When true and no zoomLink is provided, Google Calendar auto-generates a
   * Google Meet link for the event via conferenceData. When false (the
   * default) the event has no video call attached.
   */
  addVideoCall?: boolean;
  /** Free-text agenda / notes for the event body. */
  description?: string;
  /** Physical or virtual location (used when no zoomLink is set). */
  location?: string;
  /** Explicit end time "HH:MM". When provided (and after startTime), it takes
   *  precedence over `duration`. */
  endTime?: string;
  /** IANA timezone the wall-clock times are in. Defaults to Europe/London. */
  timezone?: string;
}): Promise<{ id: string; htmlLink: string }> {
  const auth = await getAuthedClient(username);
  if (!auth) throw new Error("Google Calendar not connected");

  const calendar = google.calendar({ version: "v3", auth });

  // Compute start + end as naive wall-clock strings and let Google interpret
  // them in Europe/London (handles BST/GMT transitions correctly).
  const timezone = params.timezone || "Europe/London";

  const [sh, sm] = params.startTime.split(":").map((n) => parseInt(n, 10));
  const totalStartMin = sh * 60 + sm;

  // Effective duration: an explicit endTime (later than the start) wins over the
  // `duration` param, so the form's end-time field is honoured exactly.
  let durationMin = params.duration;
  if (params.endTime) {
    const [eh, em] = params.endTime.split(":").map((n) => parseInt(n, 10));
    const endTotal = eh * 60 + em;
    if (Number.isFinite(endTotal) && endTotal > totalStartMin) durationMin = endTotal - totalStartMin;
  }

  const totalEndMin = totalStartMin + durationMin;
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

  const requestBody: Record<string, unknown> = {
    summary: params.title,
    start: { dateTime: startDateTime, timeZone: timezone },
    end:   { dateTime: endDateTime,   timeZone: timezone },
    attendees: params.attendees.map((email) => ({ email })),
  };

  // ── Description: user notes, plus a "Join:" line when a Zoom link is set. ────
  const descriptionParts: string[] = [];
  if (params.description?.trim()) descriptionParts.push(params.description.trim());
  if (params.zoomLink) descriptionParts.push(`Join: ${params.zoomLink}`);
  if (descriptionParts.length > 0) requestBody.description = descriptionParts.join("\n\n");

  // ── Location / video conferencing decision tree ──────────────────────────────
  // 1. Explicit zoomLink → location. 2. Else a user-supplied location string.
  // 3. addVideoCall (and no zoomLink) → Google Calendar auto-creates a Meet link.
  if (params.zoomLink) {
    requestBody.location = params.zoomLink;
  } else if (params.location?.trim()) {
    requestBody.location = params.location.trim();
  }
  if (!params.zoomLink && params.addVideoCall) {
    requestBody.conferenceData = {
      createRequest: {
        // Random ID per request — Google ignores duplicates.
        requestId: `basil-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    };
  }

  const res = await calendar.events.insert({
    calendarId: "primary",
    // conferenceDataVersion=1 is required for Meet auto-generation to take effect.
    conferenceDataVersion: params.addVideoCall && !params.zoomLink ? 1 : 0,
    // sendUpdates="all" → Google emails a calendar invite to every attendee.
    // Without it, attendees are added silently and never notified — which is the
    // entire point of "invite contacts".
    sendUpdates: "all",
    requestBody,
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
    // Notify attendees of the change (esp. newly-added ones get an invite).
    sendUpdates: "all",
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


// ── Answering invitations ─────────────────────────────────────────────────────

export type RsvpResponse = "accepted" | "declined" | "tentative";

/** The user is not on the event's guest list (e.g. invited through a group). */
export class NotAnAttendeeError extends Error {
  constructor() { super("You are not on this event's guest list, so there is no response to change."); }
}

export interface RespondedEvent {
  summary: string;
  start: string;
  end: string;
  timeZone: string;
  organizerName?: string;
  organizerEmail?: string;
  organizerIsSelf: boolean;
}

const oneLine = (s: string, max: number) => s.replace(/[\r\n]+/g, " ").trim().slice(0, max);

/**
 * Accept, decline or tentatively accept an invitation, optionally with a note
 * the organiser sees on their copy of the event.
 *
 * sendUpdates:"all" is what tells the organiser. The previous RSVP route
 * patched silently: a Google organiser saw the new status eventually, an
 * Outlook organiser never heard. And when the user wasn't individually on the
 * guest list it changed nothing and reported success; that is now an error.
 */
export async function respondToEvent(
  username: string,
  eventId: string,
  opts: { response: RsvpResponse; comment?: string },
): Promise<RespondedEvent> {
  const auth = await getAuthedClient(username);
  if (!auth) throw new Error("Google Calendar not connected");
  const calendar = google.calendar({ version: "v3", auth });
  const { data: ev } = await calendar.events.get({ calendarId: "primary", eventId });
  const attendees = ev.attendees ?? [];
  const idx = attendees.findIndex((a) => a.self);
  if (idx === -1) throw new NotAnAttendeeError();
  const updated = attendees.map((a, i) => i !== idx ? a : {
    ...a,
    responseStatus: opts.response,
    ...(opts.comment !== undefined ? { comment: oneLine(opts.comment, 500) } : {}),
  });
  await calendar.events.patch({
    calendarId: "primary",
    eventId,
    sendUpdates: "all",
    requestBody: { attendees: updated },
  });
  return {
    summary: ev.summary || "the meeting",
    start: ev.start?.dateTime || ev.start?.date || "",
    end: ev.end?.dateTime || ev.end?.date || "",
    timeZone: ev.start?.timeZone || "Europe/London",
    organizerName: ev.organizer?.displayName || undefined,
    organizerEmail: ev.organizer?.email || undefined,
    organizerIsSelf: ev.organizer?.self === true,
  };
}

/** "Tue 7 Oct, 15:00–15:30 (London)". Pure — exported for tests. */
export function formatSlot(startIso: string, endIso: string, timeZone: string): string {
  const s = new Date(startIso), e = new Date(endIso);
  const day = s.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone });
  const t = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone });
  const place = timeZone.split("/").pop()?.replace(/_/g, " ") ?? timeZone;
  return `${day}, ${t(s)}–${t(e)} (${place})`;
}

/**
 * Google Calendar's "Propose a new time" exists only in Google's own UI — the
 * API has no endpoint for it. So: answer Maybe (or No), put the proposed time
 * in the response note the organiser sees on the invite, and email the
 * organiser the proposal so it reaches them whatever calendar they use.
 */
export async function proposeNewTime(
  username: string,
  eventId: string,
  opts: {
    start: string;
    end: string;
    response?: "tentative" | "declined";
    note?: string;
    emailOrganizer?: boolean;
    /** Signs the email. */
    senderName: string;
    timeZone?: string;
    now?: number;
  },
): Promise<{ emailedTo?: string; comment: string }> {
  const start = new Date(opts.start), end = new Date(opts.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new RangeError("Pick a valid start and end time.");
  if (end <= start) throw new RangeError("The proposed end must be after the start.");
  if (start.getTime() < (opts.now ?? Date.now())) throw new RangeError("The proposed time is in the past.");

  const tz = opts.timeZone || "Europe/London";
  const slot = formatSlot(opts.start, opts.end, tz);
  const note = opts.note ? oneLine(opts.note, 300) : "";
  const comment = `Proposed new time: ${slot}${note ? ` — ${note}` : ""}`;
  const ev = await respondToEvent(username, eventId, { response: opts.response ?? "tentative", comment });

  if (opts.emailOrganizer === false || !ev.organizerEmail || ev.organizerIsSelf) return { comment };
  const first = (ev.organizerName ?? "").trim().split(/\s+/)[0];
  const original = ev.start && ev.end ? formatSlot(ev.start, ev.end, tz) : "the current time";
  const body = [
    first ? `Hi ${first},` : "Hi,",
    "",
    `I can't make "${ev.summary}" at ${original}. Could we move it to ${slot}?`,
    ...(note ? ["", note] : []),
    "",
    "Thanks,",
    opts.senderName.split(" ")[0] || opts.senderName,
  ].join("\n");
  await sendEmail(username, ev.organizerEmail, `New time for "${oneLine(ev.summary, 120)}"?`, body);
  return { emailedTo: ev.organizerEmail, comment };
}
