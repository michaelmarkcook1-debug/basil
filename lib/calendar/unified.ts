/**
 * One calendar across Google and Microsoft 365 ("both gardens").
 *
 * Reads whichever calendars the user has connected, tags every event with its
 * provider, merges and sorts them, drops the copy when the same meeting sits
 * on both, and finds clashes — so a client's Teams invite and the team's
 * Google meeting at the same hour are caught.
 *
 * A provider that fails is reported in `degraded` and its events are missing;
 * it is never passed off as an empty calendar. Pure helpers (mergeCalendarEvents,
 * findClashes, windowBounds) are exported for tests.
 */
import {
  checkFreeBusy,
  getEventsForDate,
  getEventsForDateRange,
  getEventsForDays,
  getEventsForMonth,
  type CalendarEvent,
  type FreeBusyResult,
} from "@/lib/google/calendar";
import { isGoogleConnected } from "@/lib/google/auth";
import { isMicrosoftConnected } from "@/lib/microsoft/auth";
import { checkOutlookFreeBusy, getOutlookEventsBetween } from "@/lib/microsoft/outlook-calendar";
import { getSelfIdentity } from "@/lib/self-identity";
import { addDays, dayIn, midnightIn } from "@/lib/away/calendar";

export type CalendarProvider = "google" | "microsoft";

export const PROVIDER_LABEL: Record<CalendarProvider, string> = { google: "Google Calendar", microsoft: "Outlook calendar" };

export interface ProviderFailure { provider: CalendarProvider; error: string }

export interface ClashSide {
  id: string;
  summary: string;
  start: string;
  end: string;
  provider: CalendarProvider;
  myResponseStatus: CalendarEvent["myResponseStatus"];
}

export interface Clash {
  a: ClashSide;
  b: ClashSide;
  /** The overlap itself (ISO). */
  overlapStart: string;
  overlapEnd: string;
  /** One event is on Google, the other on Outlook. */
  crossProvider: boolean;
  /** "Tue 10 Nov 15:00–16:00 Client review (Outlook calendar) clashes with 15:00–15:30 Team sync (Google Calendar)". */
  label: string;
}

export interface UnifiedCalendar {
  events: CalendarEvent[];
  /** Calendars that were read successfully. */
  providers: CalendarProvider[];
  /** Connected calendars that could not be read — their events are missing. */
  degraded: ProviderFailure[];
  clashes: Clash[];
}

/** today + N days | one day | inclusive days | a calendar month (0-based). */
export type CalendarWindow =
  | { days: number }
  | { date: string }
  | { from: string; to: string }
  | { year: number; month: number };

// ── Connections ──────────────────────────────────────────────────────────────

/** Connected calendars, Google first (it is the primary calendar when both are). */
export async function connectedCalendars(username: string): Promise<CalendarProvider[]> {
  const [google, microsoft] = await Promise.all([
    isGoogleConnected(username).catch(() => false),
    isMicrosoftConnected(username, "calendar").catch(() => false),
  ]);
  return [...(google ? ["google" as const] : []), ...(microsoft ? ["microsoft" as const] : [])];
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** [start, end) of a window in epoch ms, in the user's timezone. Pure. */
export function windowBounds(window: CalendarWindow, timezone: string, nowMs = Date.now()): { startMs: number; endMs: number } {
  if ("days" in window) {
    const today = dayIn(nowMs, timezone);
    return { startMs: midnightIn(today, timezone), endMs: midnightIn(addDays(today, window.days), timezone) };
  }
  if ("date" in window) {
    return { startMs: midnightIn(window.date, timezone), endMs: midnightIn(addDays(window.date, 1), timezone) };
  }
  if ("from" in window) {
    return { startMs: midnightIn(window.from, timezone), endMs: midnightIn(addDays(window.to, 1), timezone) };
  }
  const first = `${window.year}-${String(window.month + 1).padStart(2, "0")}-01`;
  const next = window.month === 11 ? `${window.year + 1}-01-01` : `${window.year}-${String(window.month + 2).padStart(2, "0")}-01`;
  return { startMs: midnightIn(first, timezone), endMs: midnightIn(next, timezone) };
}

const ms = (iso: string) => Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
const providerOf = (e: CalendarEvent): CalendarProvider => e.provider ?? (e.id.startsWith("ms:") ? "microsoft" : "google");
const norm = (s: string | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** The same meeting: same start and end, and the same iCalUID or the same title and organiser. */
function sameMeeting(a: CalendarEvent, b: CalendarEvent): boolean {
  if (a.isAllDay !== b.isAllDay) return false;
  if (ms(a.start) !== ms(b.start) || ms(a.end) !== ms(b.end)) return false;
  if (a.iCalUID && b.iCalUID && a.iCalUID.toLowerCase() === b.iCalUID.toLowerCase()) return true;
  if (norm(a.summary) !== norm(b.summary)) return false;
  const orgA = norm(a.organizerEmail), orgB = norm(b.organizerEmail);
  return (!!orgA && orgA === orgB) || (a.isOrganizer && b.isOrganizer);
}

/**
 * Merge per-provider lists: sort by start (all-day first on a tie, then Google
 * before Outlook) and keep one copy of a meeting that is on both. Pure.
 */
export function mergeCalendarEvents(lists: CalendarEvent[][]): CalendarEvent[] {
  const rank = (e: CalendarEvent) => (providerOf(e) === "google" ? 0 : 1);
  const all = lists.flat().sort((a, b) =>
    (ms(a.start) - ms(b.start)) || (Number(b.isAllDay) - Number(a.isAllDay)) || (rank(a) - rank(b)));
  const kept: CalendarEvent[] = [];
  const byTimes = new Map<string, CalendarEvent[]>();
  for (const e of all) {
    const key = `${ms(e.start)}|${ms(e.end)}`;
    const same = byTimes.get(key) ?? [];
    if (same.some((k) => providerOf(k) !== providerOf(e) && sameMeeting(k, e))) continue;
    same.push(e);
    byTimes.set(key, same);
    kept.push(e);
  }
  return kept;
}

/** Holds time: timed, not declined, not marked free, not an out-of-office or working-location block. */
export function blocksTime(e: CalendarEvent): boolean {
  if (e.isAllDay || e.myResponseStatus === "declined" || e.transparent) return false;
  if (e.eventType === "outOfOffice" || e.eventType === "workingLocation") return false;
  const s = ms(e.start), en = ms(e.end);
  return Number.isFinite(s) && Number.isFinite(en) && en > s;
}

function side(e: CalendarEvent): ClashSide {
  return { id: e.id, summary: e.summary, start: e.start, end: e.end, provider: providerOf(e), myResponseStatus: e.myResponseStatus };
}

function clashLabel(a: CalendarEvent, b: CalendarEvent, timezone: string): string {
  const t = (iso: string) => new Date(ms(iso)).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: timezone });
  const day = new Date(ms(a.start)).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: timezone });
  const one = (e: CalendarEvent) => `${t(e.start)}–${t(e.end)} ${e.summary} (${PROVIDER_LABEL[providerOf(e)]}${e.myResponseStatus === "needsAction" ? ", not yet answered" : e.myResponseStatus === "tentative" ? ", maybe" : ""})`;
  return `${day} ${one(a)} clashes with ${one(b)}`;
}

/**
 * Pairs of overlapping events that both hold your time (see blocksTime).
 * Back-to-back meetings do not clash. Pure — exported for tests.
 */
export function findClashes(events: CalendarEvent[], timezone = "Europe/London"): Clash[] {
  const busy = events.filter(blocksTime).sort((a, b) => ms(a.start) - ms(b.start));
  const out: Clash[] = [];
  for (let i = 0; i < busy.length; i++) {
    const a = busy[i];
    for (let j = i + 1; j < busy.length && ms(busy[j].start) < ms(a.end); j++) {
      const b = busy[j];
      const start = Math.max(ms(a.start), ms(b.start));
      const end = Math.min(ms(a.end), ms(b.end));
      if (end <= start) continue;
      out.push({
        a: side(a),
        b: side(b),
        overlapStart: new Date(start).toISOString(),
        overlapEnd: new Date(end).toISOString(),
        crossProvider: providerOf(a) !== providerOf(b),
        label: clashLabel(a, b, timezone),
      });
    }
  }
  return out;
}

// ── Reads ────────────────────────────────────────────────────────────────────

function readGoogle(username: string, window: CalendarWindow, timezone: string): Promise<CalendarEvent[]> {
  if ("days" in window) return getEventsForDays(username, window.days, timezone);
  if ("date" in window) return getEventsForDate(username, window.date, timezone);
  if ("from" in window) return getEventsForDateRange(username, window.from, window.to, timezone);
  return getEventsForMonth(username, window.year, window.month, timezone);
}

async function readMicrosoft(username: string, window: CalendarWindow, timezone: string): Promise<CalendarEvent[]> {
  const { startMs, endMs } = windowBounds(window, timezone);
  const identity = await getSelfIdentity(username).catch(() => ({ emails: [] as string[], names: [] as string[] }));
  const events = await getOutlookEventsBetween(username, startMs, endMs, { timezone, self: { emails: identity.emails, names: identity.names } });
  if (events === null) throw new Error("Microsoft 365 sign-in has expired — reconnect it in Settings.");
  return events;
}

const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/**
 * Events from every connected calendar for the window, merged, de-duplicated
 * and checked for clashes. A failing calendar lands in `degraded`; the rest
 * are still returned. `providers` limits which calendars are read (defaults
 * to every connected one).
 */
export async function readCalendar(
  username: string,
  window: CalendarWindow,
  timezone = "Europe/London",
  opts: { providers?: CalendarProvider[] } = {},
): Promise<UnifiedCalendar> {
  const wanted = opts.providers ?? (await connectedCalendars(username));
  const results = await Promise.allSettled(wanted.map((p) =>
    p === "google" ? readGoogle(username, window, timezone) : readMicrosoft(username, window, timezone)));
  const lists: CalendarEvent[][] = [];
  const providers: CalendarProvider[] = [];
  const degraded: ProviderFailure[] = [];
  results.forEach((r, i) => {
    const provider = wanted[i];
    if (r.status === "fulfilled") {
      providers.push(provider);
      lists.push(r.value.map((e) => (e.provider ? e : { ...e, provider })));
    } else {
      console.warn(`[calendar] ${provider} read failed:`, short(r.reason));
      degraded.push({ provider, error: short(r.reason) });
    }
  });
  const events = mergeCalendarEvents(lists);
  return { events, providers, degraded, clashes: findClashes(events, timezone) };
}

/** "Outlook calendar" / "Google Calendar and Outlook calendar". */
export function describeProviders(list: Array<{ provider: CalendarProvider } | CalendarProvider>): string {
  return list.map((x) => PROVIDER_LABEL[typeof x === "string" ? x : x.provider]).join(" and ");
}

// ── Attendees' availability ──────────────────────────────────────────────────

/**
 * Attendees' busy blocks: Google's freebusy when Google is connected, and
 * Outlook's getSchedule for anyone Google could not see (or for everyone when
 * only Microsoft is connected). An attendee neither can read keeps its error.
 */
export async function checkAttendeeFreeBusy(username: string, emails: string[], timeMin: Date, timeMax: Date): Promise<FreeBusyResult[]> {
  if (emails.length === 0) return [];
  const connected = await connectedCalendars(username);
  if (connected.length === 0) return emails.map((email) => ({ email, busy: [], error: "No calendar connected" }));
  let results: FreeBusyResult[] = connected.includes("google")
    ? await checkFreeBusy(username, emails, timeMin, timeMax)
    : emails.map((email) => ({ email, busy: [], error: "Not checked" }));
  const unseen = results.filter((r) => r.error).map((r) => r.email);
  if (unseen.length && connected.includes("microsoft")) {
    const ms365 = await checkOutlookFreeBusy(username, unseen, timeMin, timeMax);
    const byEmail = new Map(ms365.filter((r) => !r.error).map((r) => [r.email.toLowerCase(), r]));
    results = results.map((r) => (r.error && byEmail.get(r.email.toLowerCase())) || r);
  }
  return results;
}
