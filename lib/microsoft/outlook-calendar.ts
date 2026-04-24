/**
 * Microsoft Graph Calendar functions.
 *
 * Mirrors the shape and behaviour of lib/google/calendar.ts — same interface
 * field names, same function signatures, same date-label logic, same timezone
 * (Europe/London).  Uses raw fetch via graphGet/graphFetch (no external SDK).
 */

import { graphGet, graphFetch } from "./auth";

// ── Types ────────────────────────────────────────────────────────────────────

export interface OutlookCalendarEvent {
  id:            string;
  summary:       string;           // subject
  start:         string;           // ISO datetime
  end:           string;           // ISO datetime
  isAllDay:      boolean;
  hasVideo:      boolean;          // true if isOnlineMeeting or onlineMeetingUrl present
  attendeeCount: number;
  attendees:     string[];         // display names
  dateLabel?:    string;           // "Today", "Tomorrow", or day name
}

// ── Graph response shapes (internal) ─────────────────────────────────────────

interface GraphDateTimeTimeZone {
  dateTime: string;
  timeZone: string;
}

interface GraphAttendee {
  emailAddress: { address: string; name: string };
  type:         string;
}

interface GraphEvent {
  id:                 string;
  subject:            string;
  start:              GraphDateTimeTimeZone;
  end:                GraphDateTimeTimeZone;
  isAllDay:           boolean;
  isOnlineMeeting:    boolean;
  onlineMeetingUrl?:  string;
  attendees:          GraphAttendee[];
}

interface GraphListResponse<T> {
  value: T[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const TZ = "Europe/London";

const EVENT_SELECT =
  "id,subject,start,end,isAllDay,isOnlineMeeting,onlineMeetingUrl,attendees";

function toISOLocal(dateStr: string): string {
  // Graph returns "YYYY-MM-DDTHH:MM:SS.0000000" — normalise to ISO
  return new Date(dateStr).toISOString();
}

function dateLabel(eventDateStr: string): string {
  const now       = new Date();
  const todayStr  = now.toLocaleDateString("en-CA", { timeZone: TZ });
  const londonToday = new Date(`${todayStr}T00:00:00`);
  const tomorrowDate = new Date(londonToday);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr = tomorrowDate.toLocaleDateString("en-CA", { timeZone: TZ });

  const eventDate = eventDateStr.substring(0, 10);
  if (eventDate === todayStr)    return "Today";
  if (eventDate === tomorrowStr) return "Tomorrow";
  return new Date(`${eventDate}T12:00:00`).toLocaleDateString("en-GB", {
    weekday:  "long",
    timeZone: TZ,
  });
}

function mapEvent(e: GraphEvent, label: string): OutlookCalendarEvent {
  const attendees = (e.attendees || []).map(
    (a) => a.emailAddress?.name || a.emailAddress?.address || ""
  ).filter(Boolean);

  return {
    id:            e.id,
    summary:       e.subject || "Untitled",
    start:         toISOLocal(e.start?.dateTime || ""),
    end:           toISOLocal(e.end?.dateTime   || ""),
    isAllDay:      !!e.isAllDay,
    hasVideo:      !!(e.isOnlineMeeting || e.onlineMeetingUrl),
    attendeeCount: attendees.length,
    attendees,
    dateLabel:     label,
  };
}

function isoDate(d: Date): string {
  return d.toISOString();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a calendar event via Microsoft Graph.
 * Timezone is always Europe/London.
 */
export async function createOutlookCalendarEvent(params: {
  title:       string;
  attendees:   string[];   // email addresses
  date:        string;     // YYYY-MM-DD
  startTime:   string;     // HH:MM
  duration:    number;     // minutes
  teamsLink?:  string;
}): Promise<{ id: string }> {
  const [sh, sm] = params.startTime.split(":").map((n) => parseInt(n, 10));
  const totalStartMin = sh * 60 + sm;
  const totalEndMin   = totalStartMin + params.duration;
  const endHours      = Math.floor(totalEndMin / 60);
  const endMins       = totalEndMin % 60;

  const dayOffset    = Math.floor(endHours / 24);
  const endHourInDay = endHours % 24;

  const startDateTime = `${params.date}T${String(sh).padStart(2, "0")}:${String(sm).padStart(2, "0")}:00`;
  const endDate = new Date(`${params.date}T00:00:00Z`);
  endDate.setUTCDate(endDate.getUTCDate() + dayOffset);
  const endDateStr    = endDate.toISOString().slice(0, 10);
  const endDateTime   = `${endDateStr}T${String(endHourInDay).padStart(2, "0")}:${String(endMins).padStart(2, "0")}:00`;

  const body: Record<string, unknown> = {
    subject: params.title,
    start:   { dateTime: startDateTime, timeZone: TZ },
    end:     { dateTime: endDateTime,   timeZone: TZ },
    attendees: params.attendees.map((email) => ({
      emailAddress: { address: email, name: email },
      type:         "required",
    })),
  };

  if (params.teamsLink) {
    body.isOnlineMeeting = true;
  }

  const res = await graphFetch("/me/events", {
    method: "POST",
    body:   JSON.stringify(body),
  });

  if (!res) throw new Error("Microsoft not connected");
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`createOutlookCalendarEvent HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json() as { id: string };
  return { id: data.id };
}

/**
 * Fetch all events for a given calendar month.
 */
export async function getOutlookEventsForMonth(
  year:  number,
  month: number  // 0-based (same as Date constructor)
): Promise<OutlookCalendarEvent[]> {
  const startOfMonth = new Date(year, month, 1);
  const endOfMonth   = new Date(year, month + 1, 0, 23, 59, 59);

  const params = new URLSearchParams({
    startDateTime: isoDate(startOfMonth),
    endDateTime:   isoDate(endOfMonth),
    $top:          "200",
    $select:       EVENT_SELECT,
  });

  try {
    const data = await graphGet<GraphListResponse<GraphEvent>>(
      `/me/calendarView?${params}`
    );
    if (!data) return [];
    return (data.value || []).map((e) =>
      mapEvent(e, dateLabel(e.start?.dateTime || ""))
    );
  } catch (err) {
    console.error("[outlook-calendar] getOutlookEventsForMonth error:", err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Fetch today's events.
 */
export async function getOutlookTodayEvents(): Promise<OutlookCalendarEvent[]> {
  return getOutlookEventsForDays(1);
}

/**
 * Fetch events for the next `days` days starting from today (Europe/London).
 */
/**
 * Returns online-meeting events from the past `daysBack` days.
 * Used by the Teams signal layer (equivalent to Zoom summaries).
 * Requires Calendars.ReadWrite scope (already granted).
 */
export async function getOutlookPastMeetings(daysBack = 30): Promise<OutlookCalendarEvent[]> {
  const now      = new Date();
  const startDate = new Date(now.getTime() - daysBack * 86_400_000);

  const params = new URLSearchParams({
    startDateTime: isoDate(startDate),
    endDateTime:   isoDate(now),
    $top:          "50",
    $select:       EVENT_SELECT,
    $filter:       "isOnlineMeeting eq true",
  });

  try {
    const data = await graphGet<GraphListResponse<GraphEvent>>(
      `/me/calendarView?${params}`
    );
    if (!data) return [];
    return (data.value || []).map((e) => mapEvent(e, ""));
  } catch (err) {
    console.error("[outlook-calendar] getOutlookPastMeetings error:", err instanceof Error ? err.message : err);
    return [];
  }
}

export async function getOutlookEventsForDays(days: number): Promise<OutlookCalendarEvent[]> {
  const now         = new Date();
  const todayStr    = now.toLocaleDateString("en-CA", { timeZone: TZ });
  const londonToday = new Date(`${todayStr}T00:00:00`);
  const endDate     = new Date(londonToday);
  endDate.setDate(endDate.getDate() + days);

  const params = new URLSearchParams({
    startDateTime: isoDate(londonToday),
    endDateTime:   isoDate(endDate),
    $top:          "50",
    $select:       EVENT_SELECT,
  });

  try {
    const data = await graphGet<GraphListResponse<GraphEvent>>(
      `/me/calendarView?${params}`
    );
    if (!data) return [];
    return (data.value || []).map((e) =>
      mapEvent(e, dateLabel(e.start?.dateTime || ""))
    );
  } catch (err) {
    console.error("[outlook-calendar] getOutlookEventsForDays error:", err instanceof Error ? err.message : err);
    return [];
  }
}
