/**
 * Microsoft Graph (Outlook / Teams) calendar.
 *
 * Every Outlook event is mapped into the same CalendarEvent shape Google's
 * produces (lib/google/calendar.ts), so the unified calendar
 * (lib/calendar/unified.ts) can merge both, find clashes across them, and send
 * every write back to the event's own provider.
 *
 * Outlook event ids carry the "ms:" prefix wherever they leave this module as
 * a CalendarEvent id; Google event ids never contain a colon (base32hex), so
 * the prefix alone tells the two apart. Functions here accept either form.
 *
 * Reads THROW on a Graph error and return null only when Microsoft is not
 * connected — the old helpers caught everything and returned [], which made a
 * failed Outlook read look like an empty day. Uses raw fetch via graphFetch.
 */

import { graphFetch } from "./auth";
import { addDays, dayIn, midnightIn } from "@/lib/away/calendar";
import type { CalendarEvent, CancelResult, FreeBusyResult, GuestTally, RespondedEvent, RsvpResponse } from "@/lib/google/calendar";

// ── Ids ──────────────────────────────────────────────────────────────────────

export const OUTLOOK_EVENT_PREFIX = "ms:";

export function isOutlookEventId(id: string): boolean {
  return typeof id === "string" && id.startsWith(OUTLOOK_EVENT_PREFIX);
}

/** The CalendarEvent id for a Graph event id. */
export function toOutlookEventId(rawId: string): string {
  return isOutlookEventId(rawId) ? rawId : `${OUTLOOK_EVENT_PREFIX}${rawId}`;
}

/** The Graph event id behind a CalendarEvent id (accepts the bare id too). */
export function rawOutlookEventId(id: string): string {
  return isOutlookEventId(id) ? id.slice(OUTLOOK_EVENT_PREFIX.length) : id;
}

// ── Errors ───────────────────────────────────────────────────────────────────

export class OutlookNotConnectedError extends Error {
  constructor() { super("Microsoft 365 is not connected (or its sign-in has expired)."); }
}

export class OutlookGraphError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** You organise this Outlook meeting, so there is no invitation to answer. */
export class OutlookNotAttendeeError extends Error {
  constructor() { super("You organise this meeting, so there is no invitation to answer."); }
}

// ── Graph shapes ─────────────────────────────────────────────────────────────

export interface GraphDateTimeTimeZone { dateTime?: string; timeZone?: string }
interface GraphEmailAddress { address?: string; name?: string }
export interface GraphAttendee { emailAddress?: GraphEmailAddress; type?: string; status?: { response?: string } }

export interface GraphEvent {
  id: string;
  iCalUId?: string;
  subject?: string;
  bodyPreview?: string;
  start?: GraphDateTimeTimeZone;
  end?: GraphDateTimeTimeZone;
  isAllDay?: boolean;
  isCancelled?: boolean;
  isOrganizer?: boolean;
  /** free | tentative | busy | oof | workingElsewhere | unknown */
  showAs?: string;
  /** singleInstance | occurrence | exception | seriesMaster */
  type?: string;
  seriesMasterId?: string | null;
  isOnlineMeeting?: boolean;
  onlineMeetingUrl?: string | null;
  onlineMeeting?: { joinUrl?: string | null } | null;
  location?: { displayName?: string | null } | null;
  attendees?: GraphAttendee[];
  organizer?: { emailAddress?: GraphEmailAddress } | null;
  /** The signed-in user's own answer. */
  responseStatus?: { response?: string } | null;
  webLink?: string;
  lastModifiedDateTime?: string;
}

const EVENT_SELECT = [
  "id", "iCalUId", "subject", "bodyPreview", "start", "end", "isAllDay", "isCancelled", "isOrganizer",
  "showAs", "type", "seriesMasterId", "isOnlineMeeting", "onlineMeetingUrl", "onlineMeeting", "location",
  "attendees", "organizer", "responseStatus", "webLink", "lastModifiedDateTime",
].join(",");

/** Every read asks Graph for UTC so times convert without guessing Windows zone names. */
const PREFER_UTC = { Prefer: 'outlook.timezone="UTC"' };
const DAY_MS = 86_400_000;

// ── Time helpers (pure) ──────────────────────────────────────────────────────

function tzOffsetMs(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - ms;
}

function isIana(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/**
 * Epoch ms of a Graph dateTimeTimeZone. Graph returns "2026-11-10T15:00:00.0000000"
 * plus a zone name; reads ask for UTC. An IANA zone is converted properly; a
 * Windows zone name we cannot map is read as UTC (we asked for UTC). Pure.
 */
export function graphDateToMs(dt: GraphDateTimeTimeZone | null | undefined): number {
  if (!dt?.dateTime) return NaN;
  const wall = dt.dateTime.replace(/(\.\d{3})\d+/, "$1");
  if (/(?:[zZ]|[+-]\d\d:\d\d)$/.test(wall)) return Date.parse(wall);
  const asUtc = Date.parse(`${wall}Z`);
  const tz = (dt.timeZone || "UTC").trim();
  if (/utc|^gmt$|coordinated universal time/i.test(tz) || !isIana(tz)) return asUtc;
  const first = asUtc - tzOffsetMs(asUtc, tz);
  return asUtc - tzOffsetMs(first, tz);
}

/** YYYY-MM-DD of an all-day boundary. All-day events are midnight-to-midnight; a converted one is rounded back to its midnight. */
function allDayDate(dt: GraphDateTimeTimeZone | null | undefined): string {
  const raw = dt?.dateTime ?? "";
  if (/T00:00:00/.test(raw) || raw.length === 10) return raw.slice(0, 10);
  const ms = Date.parse(`${raw.replace(/(\.\d{3})\d+/, "$1")}Z`);
  return Number.isNaN(ms) ? raw.slice(0, 10) : new Date(Math.round(ms / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
}

/** "HH", "MM" of an instant on the wall clock in `tz`. */
function wallClock(ms: number, tz: string): [number, number] {
  const s = new Date(ms).toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const [h, m] = s.split(":").map((x) => parseInt(x, 10));
  return [h, m];
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * ISO 8601 with the user's UTC offset ("2026-11-10T15:00:00+01:00"), the way
 * Google returns event times — pages group events by the first 10 characters,
 * which a UTC string would put on the wrong day for anyone west or east of UTC. Pure.
 */
export function isoInZone(ms: number, tz: string): string {
  let offset = 0;
  try { offset = tzOffsetMs(ms, tz); } catch { offset = 0; }
  const wall = new Date(ms + offset).toISOString().slice(0, 19);
  if (offset === 0) return `${wall}Z`;
  const abs = Math.abs(offset) / 60_000;
  return `${wall}${offset > 0 ? "+" : "-"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Start and end wall-clock strings for a date + HH:MM + minutes (crossing midnight rolls the date). Pure. */
export function wallRange(date: string, startTime: string, durationMin: number, endTime?: string): { start: string; end: string } {
  const [sh, sm] = startTime.split(":").map((n) => parseInt(n, 10));
  const startTotal = sh * 60 + sm;
  let duration = durationMin;
  if (endTime) {
    const [eh, em] = endTime.split(":").map((n) => parseInt(n, 10));
    const endTotal = eh * 60 + em;
    if (Number.isFinite(endTotal) && endTotal > startTotal) duration = endTotal - startTotal;
  }
  const endTotal = startTotal + duration;
  const endDay = addDays(date, Math.floor(endTotal / 1440));
  const endMin = endTotal % 1440;
  return {
    start: `${date}T${pad(sh)}:${pad(sm)}:00`,
    end: `${endDay}T${pad(Math.floor(endMin / 60))}:${pad(endMin % 60)}:00`,
  };
}

export function dayLabelFor(day: string, timezone: string, nowMs: number): string {
  const today = dayIn(nowMs, timezone);
  if (day === today) return "Today";
  if (day === addDays(today, 1)) return "Tomorrow";
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}

// ── Mapping (pure) ───────────────────────────────────────────────────────────

function cleanSummary(summary: string): string {
  return summary.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\u{FE0F}\u{200D}]+\s*/gu, "").trim();
}

const VIDEO_URL = /(https:\/\/[^\s<"]+(?:zoom\.us\/j|teams\.microsoft\.com\/l\/meetup|teams\.live\.com\/meet|meet\.google\.com)[^\s<"]*)/i;

function myAnswer(response: string | undefined, isOrganizer: boolean): CalendarEvent["myResponseStatus"] {
  switch ((response ?? "").toLowerCase()) {
    case "organizer":
    case "accepted": return "accepted";
    case "tentativelyaccepted": return "tentative";
    case "declined": return "declined";
    default: return isOrganizer ? "accepted" : "needsAction";
  }
}

export interface OutlookSelf { emails: string[]; names?: string[] }

/**
 * One Graph event → CalendarEvent. Pure — exported for tests.
 * `self` removes the user from the guest lists (Graph has no "self" flag).
 */
export function mapOutlookEvent(e: GraphEvent, ctx: { timezone: string; self?: OutlookSelf; now?: number }): CalendarEvent {
  const selfEmails = new Set((ctx.self?.emails ?? []).map((s) => s.toLowerCase()));
  const selfNames = new Set((ctx.self?.names ?? []).map((s) => s.toLowerCase()));
  const isMe = (a: GraphAttendee) => {
    const addr = a.emailAddress?.address?.toLowerCase();
    const name = a.emailAddress?.name?.toLowerCase();
    return (!!addr && selfEmails.has(addr)) || (!!name && selfNames.has(name));
  };
  const others = (e.attendees ?? []).filter((a) => !isMe(a) && (a.type ?? "").toLowerCase() !== "resource");
  const names = others.map((a) => a.emailAddress?.name || a.emailAddress?.address || "").filter(Boolean);

  const guests: GuestTally = { total: 0, accepted: 0, tentative: 0, declined: 0, waiting: 0 };
  for (const a of others) {
    guests.total++;
    const r = (a.status?.response ?? "").toLowerCase();
    if (r === "accepted" || r === "organizer") guests.accepted++;
    else if (r === "tentativelyaccepted") guests.tentative++;
    else if (r === "declined") guests.declined++;
    else guests.waiting++;
  }

  const isAllDay = e.isAllDay === true;
  const startMs = graphDateToMs(e.start);
  const endMs = graphDateToMs(e.end);
  const start = isAllDay ? allDayDate(e.start) : (Number.isNaN(startMs) ? "" : isoInZone(startMs, ctx.timezone));
  const end = isAllDay ? allDayDate(e.end) : (Number.isNaN(endMs) ? "" : isoInZone(endMs, ctx.timezone));
  const day = isAllDay ? start : (Number.isNaN(startMs) ? "" : dayIn(startMs, ctx.timezone));

  const location = e.location?.displayName?.trim() || undefined;
  const description = (e.bodyPreview ?? "").trim().slice(0, 600) || undefined;
  const videoLink = e.onlineMeeting?.joinUrl || e.onlineMeetingUrl
    || `${location ?? ""} ${description ?? ""}`.match(VIDEO_URL)?.[1] || undefined;
  const isOrganizer = e.isOrganizer === true;
  const showAs = (e.showAs ?? "").toLowerCase();

  return {
    id: toOutlookEventId(e.id),
    summary: cleanSummary(e.subject || "Untitled") || "Untitled",
    start,
    end,
    isAllDay,
    hasVideo: !!(e.isOnlineMeeting || videoLink),
    attendeeCount: names.length,
    attendees: names,
    dateLabel: day ? dayLabelFor(day, ctx.timezone, ctx.now ?? Date.now()) : undefined,
    location,
    description,
    videoLink,
    isOrganizer,
    myResponseStatus: myAnswer(e.responseStatus?.response, isOrganizer),
    attendeeDetails: others
      .filter((a) => (a.status?.response ?? "").toLowerCase() !== "declined" && (a.emailAddress?.address || a.emailAddress?.name))
      .map((a) => ({ name: a.emailAddress?.name || "", email: (a.emailAddress?.address || "").toLowerCase() })),
    organizerName: e.organizer?.emailAddress?.name || undefined,
    organizerEmail: e.organizer?.emailAddress?.address?.toLowerCase() || undefined,
    guests,
    recurring: Boolean(e.seriesMasterId) || e.type === "occurrence" || e.type === "exception",
    eventType: showAs === "oof" ? "outOfOffice" : "default",
    ...(showAs === "free" || showAs === "workingelsewhere" ? { transparent: true } : {}),
    ...(e.iCalUId ? { iCalUID: e.iCalUId } : {}),
    provider: "microsoft",
  };
}

// ── Graph plumbing ───────────────────────────────────────────────────────────

const enc = (id: string) => encodeURIComponent(rawOutlookEventId(id));

async function graphCall<T = Record<string, unknown>>(username: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await graphFetch(username, path, init);
  if (!res) throw new OutlookNotConnectedError();
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new OutlookGraphError(res.status, `Graph ${init.method ?? "GET"} ${path.split("?")[0]} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (res.status === 202 || res.status === 204) return {} as T;
  const text = await res.text().catch(() => "");
  return (text ? JSON.parse(text) : {}) as T;
}

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

// The user's own Microsoft addresses, so they are not listed as their own guest.
const selfCache = new Map<string, { at: number; self: OutlookSelf }>();
async function outlookSelf(username: string): Promise<OutlookSelf> {
  const hit = selfCache.get(username);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.self;
  let self: OutlookSelf = { emails: [] };
  try {
    const me = await graphCall<{ mail?: string; userPrincipalName?: string; displayName?: string }>(username, "/me?$select=mail,userPrincipalName,displayName", { method: "GET" });
    self = {
      emails: [me.mail, me.userPrincipalName].filter((x): x is string => !!x && x.includes("@")).map((x) => x.toLowerCase()),
      names: me.displayName ? [me.displayName.toLowerCase()] : [],
    };
    selfCache.set(username, { at: Date.now(), self });
  } catch {
    // Best effort: without it the user may appear on their own guest list.
  }
  return self;
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * Every Outlook event that overlaps [startMs, endMs), paged, mapped to
 * CalendarEvent and sorted by start. Cancelled meetings are left out (Google
 * does not list them either). Null when Microsoft is not connected; throws on
 * a Graph error so the caller can report the failure.
 */
export async function getOutlookEventsBetween(
  username: string,
  startMs: number,
  endMs: number,
  opts: { timezone?: string; self?: OutlookSelf; now?: number; maxPages?: number } = {},
): Promise<CalendarEvent[] | null> {
  const timezone = opts.timezone || "Europe/London";
  const params = new URLSearchParams({
    startDateTime: new Date(startMs).toISOString(),
    endDateTime: new Date(endMs).toISOString(),
    $select: EVENT_SELECT,
    $top: "200",
  });
  let url: string | undefined = `/me/calendarView?${params}`;
  const raw: GraphEvent[] = [];
  try {
    for (let page = 0; url && page < (opts.maxPages ?? 10); page++) {
      const data: { value?: GraphEvent[]; "@odata.nextLink"?: string } = await graphCall(username, url, { method: "GET", headers: PREFER_UTC });
      raw.push(...(data.value ?? []));
      url = data["@odata.nextLink"];
    }
  } catch (e) {
    if (e instanceof OutlookNotConnectedError) return null;
    throw e;
  }
  const mine = await outlookSelf(username);
  const self: OutlookSelf = {
    emails: [...mine.emails, ...(opts.self?.emails ?? [])],
    names: [...(mine.names ?? []), ...(opts.self?.names ?? [])],
  };
  return raw
    .filter((e) => !e.isCancelled)
    .map((e) => mapOutlookEvent(e, { timezone, self, now: opts.now }))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

/** One Outlook event, raw (UTC times). Throws when it cannot be read. */
export async function getOutlookEvent(username: string, id: string): Promise<GraphEvent> {
  return graphCall<GraphEvent>(username, `/me/events/${enc(id)}?$select=${EVENT_SELECT}`, { method: "GET", headers: PREFER_UTC });
}

/** Back-compat alias: the old Outlook event shape is a subset of CalendarEvent. */
export type OutlookCalendarEvent = CalendarEvent;

/** Events from today (Europe/London unless given) for `days` days. [] on failure (legacy helper; the unified calendar reports failures). */
export async function getOutlookEventsForDays(username: string, days: number, timezone = "Europe/London"): Promise<CalendarEvent[]> {
  const today = dayIn(Date.now(), timezone);
  try {
    return (await getOutlookEventsBetween(username, midnightIn(today, timezone), midnightIn(addDays(today, days), timezone), { timezone })) ?? [];
  } catch (err) {
    console.error("[outlook-calendar] getOutlookEventsForDays error:", err instanceof Error ? err.message : err);
    return [];
  }
}

export async function getOutlookTodayEvents(username: string, timezone = "Europe/London"): Promise<CalendarEvent[]> {
  return getOutlookEventsForDays(username, 1, timezone);
}

/** All events in a calendar month (0-based). [] on failure (legacy helper). */
export async function getOutlookEventsForMonth(username: string, year: number, month: number, timezone = "Europe/London"): Promise<CalendarEvent[]> {
  const first = `${year}-${pad(month + 1)}-01`;
  const next = month === 11 ? `${year + 1}-01-01` : `${year}-${pad(month + 2)}-01`;
  try {
    return (await getOutlookEventsBetween(username, midnightIn(first, timezone), midnightIn(next, timezone), { timezone })) ?? [];
  } catch (err) {
    console.error("[outlook-calendar] getOutlookEventsForMonth error:", err instanceof Error ? err.message : err);
    return [];
  }
}

/** Online meetings from the past `daysBack` days (Teams signal layer). [] on failure. */
export async function getOutlookPastMeetings(username: string, daysBack = 30): Promise<CalendarEvent[]> {
  const now = Date.now();
  try {
    const events = (await getOutlookEventsBetween(username, now - daysBack * DAY_MS, now, {})) ?? [];
    return events.filter((e) => e.hasVideo).map((e) => ({ ...e, dateLabel: "" }));
  } catch (err) {
    console.error("[outlook-calendar] getOutlookPastMeetings error:", err instanceof Error ? err.message : err);
    return [];
  }
}

// ── Writes ───────────────────────────────────────────────────────────────────

const toAttendees = (emails: string[]) => emails.map((address) => ({ emailAddress: { address }, type: "required" }));

/**
 * Create an event on the user's Outlook calendar. Graph sends the invitations
 * itself. Same parameters as Google's createCalendarEvent; `addVideoCall`
 * makes it an online meeting on the account's default provider (Teams).
 */
export async function createOutlookCalendarEvent(
  username: string,
  params: {
    title: string;
    attendees: string[];
    date: string;       // YYYY-MM-DD
    startTime: string;  // HH:MM
    duration: number;   // minutes
    endTime?: string;
    zoomLink?: string;
    addVideoCall?: boolean;
    description?: string;
    location?: string;
    timezone?: string;
    /** Legacy: any value makes it a Teams meeting. */
    teamsLink?: string;
  },
): Promise<{ id: string; htmlLink: string }> {
  const timeZone = params.timezone || "Europe/London";
  const { start, end } = wallRange(params.date, params.startTime, params.duration, params.endTime);
  const body: Record<string, unknown> = {
    subject: params.title,
    start: { dateTime: start, timeZone },
    end: { dateTime: end, timeZone },
    attendees: toAttendees(params.attendees),
  };
  const notes: string[] = [];
  if (params.description?.trim()) notes.push(params.description.trim());
  if (params.zoomLink) notes.push(`Join: ${params.zoomLink}`);
  if (notes.length) body.body = { contentType: "Text", content: notes.join("\n\n") };
  if (params.zoomLink) body.location = { displayName: params.zoomLink };
  else if (params.location?.trim()) body.location = { displayName: params.location.trim() };
  if (!params.zoomLink && (params.addVideoCall || params.teamsLink)) body.isOnlineMeeting = true;

  const data = await graphCall<{ id: string; webLink?: string }>(username, "/me/events", post(body));
  return { id: toOutlookEventId(data.id), htmlLink: data.webLink || "" };
}

/**
 * Edit an Outlook event: title, guests, date, start time, length. Graph tells
 * the guests. An all-day event stays all-day — only its days move (the Google
 * twin of this was bug B11).
 */
export async function updateOutlookEvent(
  username: string,
  id: string,
  params: { title?: string; date?: string; startTime?: string; duration?: number; attendees?: string[] },
  timezone = "Europe/London",
): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (params.title) patch.subject = params.title;
  if (params.attendees) patch.attendees = toAttendees(params.attendees);
  if (params.date || params.startTime || params.duration !== undefined) {
    const ev = await getOutlookEvent(username, id);
    if (ev.isAllDay) {
      const startDay = allDayDate(ev.start);
      const span = Math.max(1, Math.round((Date.parse(`${allDayDate(ev.end)}T00:00:00Z`) - Date.parse(`${startDay}T00:00:00Z`)) / DAY_MS));
      const newStart = params.date || startDay;
      patch.isAllDay = true;
      patch.start = { dateTime: `${newStart}T00:00:00`, timeZone: timezone };
      patch.end = { dateTime: `${addDays(newStart, span)}T00:00:00`, timeZone: timezone };
    } else {
      const startMs = graphDateToMs(ev.start);
      const endMs = graphDateToMs(ev.end);
      const date = params.date || dayIn(startMs, timezone);
      const [h, m] = params.startTime ? params.startTime.split(":").map((x) => parseInt(x, 10)) : wallClock(startMs, timezone);
      const duration = params.duration ?? Math.round((endMs - startMs) / 60_000);
      const range = wallRange(date, `${pad(h)}:${pad(m)}`, duration);
      patch.start = { dateTime: range.start, timeZone: timezone };
      patch.end = { dateTime: range.end, timeZone: timezone };
    }
  }
  if (Object.keys(patch).length === 0) return;
  await graphCall(username, `/me/events/${enc(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
}

function guestsOf(ev: GraphEvent, selfEmails: string[] = []): string[] {
  const mine = new Set(selfEmails.map((s) => s.toLowerCase()));
  return (ev.attendees ?? [])
    .filter((a) => (a.type ?? "").toLowerCase() !== "resource" && (a.status?.response ?? "").toLowerCase() !== "declined")
    .map((a) => (a.emailAddress?.address ?? "").toLowerCase())
    .filter((a) => a && !mine.has(a));
}

/**
 * Cancel a meeting you organise (Graph tells every guest, and the note rides
 * on the cancellation) or leave one you were invited to (decline, with the
 * note to the organiser, then remove it from your calendar).
 *
 * Graph has no silent cancel for a meeting with guests: deleting it on the
 * organiser's calendar also sends the cancellation. So notify:false still
 * tells them, and `told` says so.
 */
export async function cancelOutlookEvent(username: string, id: string, opts: { notify: boolean; note?: string }): Promise<CancelResult> {
  const ev = await getOutlookEvent(username, id);
  const self = await outlookSelf(username);
  const summary = ev.subject || "the meeting";
  const note = (opts.note ?? "").trim().slice(0, 2000);
  const guests = guestsOf(ev, self.emails);

  if (ev.isOrganizer) {
    if (opts.notify) {
      await graphCall(username, `/me/events/${enc(id)}/cancel`, post({ comment: note }));
      return { role: "organiser", summary, told: guests, noteSent: !!note && guests.length > 0 };
    }
    await graphCall(username, `/me/events/${enc(id)}`, { method: "DELETE" });
    return { role: "organiser", summary, told: guests, noteSent: false };
  }

  await graphCall(username, `/me/events/${enc(id)}/decline`, post({ comment: note, sendResponse: opts.notify }));
  try {
    await graphCall(username, `/me/events/${enc(id)}`, { method: "DELETE" });
  } catch (e) {
    // Declining usually moves it to Deleted Items already.
    if (!(e instanceof OutlookGraphError && e.status === 404)) throw e;
  }
  const organizerEmail = ev.organizer?.emailAddress?.address?.toLowerCase();
  return { role: "guest", summary, told: opts.notify && organizerEmail ? [organizerEmail] : [], noteSent: false };
}

const RSVP_ACTION: Record<RsvpResponse, string> = { accepted: "accept", tentative: "tentativelyAccept", declined: "decline" };

function responded(ev: GraphEvent): RespondedEvent {
  const s = graphDateToMs(ev.start), e = graphDateToMs(ev.end);
  return {
    summary: ev.subject || "the meeting",
    start: ev.isAllDay ? allDayDate(ev.start) : (Number.isNaN(s) ? "" : new Date(s).toISOString()),
    end: ev.isAllDay ? allDayDate(ev.end) : (Number.isNaN(e) ? "" : new Date(e).toISOString()),
    timeZone: "UTC",
    organizerName: ev.organizer?.emailAddress?.name || undefined,
    organizerEmail: ev.organizer?.emailAddress?.address?.toLowerCase() || undefined,
    organizerIsSelf: ev.isOrganizer === true,
  };
}

/** Accept, decline or tentatively accept an Outlook invitation; the organiser is told unless notify is false. */
export async function respondToOutlookEvent(
  username: string,
  id: string,
  opts: { response: RsvpResponse; comment?: string; notify?: boolean },
): Promise<RespondedEvent> {
  const ev = await getOutlookEvent(username, id);
  if (ev.isOrganizer) throw new OutlookNotAttendeeError();
  await graphCall(username, `/me/events/${enc(id)}/${RSVP_ACTION[opts.response]}`, post({
    comment: (opts.comment ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 500),
    sendResponse: opts.notify !== false,
  }));
  return responded(ev);
}

/**
 * Propose a new time the Outlook way: answer Maybe (or No) with a
 * proposedNewTime, which the organiser sees as a real "new time proposed".
 * When the organiser does not accept proposals Graph refuses it, and the
 * proposal goes in the response note instead. `comment` is the note text.
 */
export async function proposeOutlookNewTime(
  username: string,
  id: string,
  opts: { start: string; end: string; response?: "tentative" | "declined"; comment: string },
): Promise<{ emailedTo?: string; comment: string; native: boolean }> {
  const ev = await getOutlookEvent(username, id);
  if (ev.isOrganizer) throw new OutlookNotAttendeeError();
  const action = opts.response === "declined" ? "decline" : "tentativelyAccept";
  const utc = (iso: string) => ({ dateTime: new Date(iso).toISOString().replace(/Z$/, ""), timeZone: "UTC" });
  const comment = opts.comment.replace(/[\r\n]+/g, " ").trim().slice(0, 500);
  let native = true;
  try {
    await graphCall(username, `/me/events/${enc(id)}/${action}`, post({
      comment, sendResponse: true, proposedNewTime: { start: utc(opts.start), end: utc(opts.end) },
    }));
  } catch (e) {
    if (!(e instanceof OutlookGraphError && e.status === 400)) throw e;
    native = false;
    await graphCall(username, `/me/events/${enc(id)}/${action}`, post({ comment, sendResponse: true }));
  }
  return { emailedTo: ev.organizer?.emailAddress?.address?.toLowerCase() || undefined, comment, native };
}

/**
 * Forward an Outlook meeting to more people. Graph's forward sends them the
 * invitation and, from an attendee's mailbox, tells the organiser and adds
 * them to the organiser's copy.
 */
export async function forwardOutlookEvent(username: string, id: string, emails: string[]): Promise<{ summary: string; added: string[] }> {
  const ev = await getOutlookEvent(username, id);
  const existing = new Set((ev.attendees ?? []).map((a) => (a.emailAddress?.address ?? "").toLowerCase()));
  const added = [...new Set(emails.map((e) => e.trim()).filter(Boolean))].filter((e) => !existing.has(e.toLowerCase()));
  if (added.length) {
    await graphCall(username, `/me/events/${enc(id)}/forward`, post({ toRecipients: added.map((address) => ({ emailAddress: { address } })) }));
  }
  return { summary: ev.subject || id, added };
}

/**
 * Attendees' busy blocks from Outlook (Graph getSchedule) — the Microsoft twin
 * of Google's freebusy query. Free and working-elsewhere blocks are not busy.
 */
export async function checkOutlookFreeBusy(username: string, emails: string[], timeMin: Date, timeMax: Date): Promise<FreeBusyResult[]> {
  if (emails.length === 0) return [];
  const utc = (d: Date) => ({ dateTime: d.toISOString().replace(/Z$/, ""), timeZone: "UTC" });
  try {
    const data = await graphCall<{ value?: Array<{ scheduleId?: string; error?: { message?: string; responseCode?: string }; scheduleItems?: Array<{ status?: string; start?: GraphDateTimeTimeZone; end?: GraphDateTimeTimeZone }> }> }>(
      username, "/me/calendar/getSchedule",
      { ...post({ schedules: emails, startTime: utc(timeMin), endTime: utc(timeMax), availabilityViewInterval: 30 }), headers: PREFER_UTC },
    );
    const byId = new Map((data.value ?? []).map((s) => [(s.scheduleId ?? "").toLowerCase(), s]));
    return emails.map((email) => {
      const s = byId.get(email.toLowerCase());
      if (!s) return { email, busy: [], error: "Calendar not accessible" };
      if (s.error) return { email, busy: [], error: s.error.message || s.error.responseCode || "Access denied" };
      return {
        email,
        busy: (s.scheduleItems ?? [])
          .filter((i) => !["free", "workingelsewhere"].includes((i.status ?? "").toLowerCase()))
          .map((i) => ({ start: new Date(graphDateToMs(i.start)).toISOString(), end: new Date(graphDateToMs(i.end)).toISOString() })),
      };
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return emails.map((email) => ({ email, busy: [], error: msg }));
  }
}

/**
 * The dedupe key for one VERSION of an Outlook event, for the change webhook:
 * the id plus lastModifiedDateTime, so a moved, renamed or cancelled meeting is
 * a new signal while a redelivered notification is not. Falls back to the
 * times and cancelled flag when Graph omits lastModifiedDateTime. Pure.
 */
export function outlookChangeKey(
  eventId: string,
  ev: { lastModifiedDateTime?: string; start?: { dateTime?: string }; end?: { dateTime?: string }; isCancelled?: boolean },
): string {
  const version = ev.lastModifiedDateTime || `${ev.start?.dateTime ?? ""}|${ev.end?.dateTime ?? ""}|${ev.isCancelled ? "cancelled" : ""}`;
  return `outlook-cal:${rawOutlookEventId(eventId)}@${version}`;
}
