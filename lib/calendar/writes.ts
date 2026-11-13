/**
 * Calendar writes, sent to the calendar the event lives on.
 *
 * An Outlook event's id starts with "ms:" (lib/microsoft/outlook-calendar.ts);
 * anything else is a Google event. Cancel, RSVP, propose, forward and edit act
 * on that event's own provider. New events go on the primary calendar —
 * Google when it is connected, otherwise Microsoft 365 — unless a provider is
 * asked for explicitly.
 *
 * The event-id functions keep the names and signatures of their Google
 * originals (cancelEvent, respondToEvent, proposeNewTime, updateCalendarEvent,
 * forwardEvent), so a route switches by changing its import.
 */
import {
  cancelEvent as cancelGoogleEvent,
  createCalendarEvent as createGoogleEvent,
  forwardEvent as forwardGoogleEvent,
  formatSlot,
  NotAnAttendeeError,
  proposeNewTime as proposeGoogleTime,
  respondToEvent as respondToGoogleEvent,
  updateCalendarEvent as updateGoogleEvent,
  type CancelResult,
  type RespondedEvent,
  type RsvpResponse,
} from "@/lib/google/calendar";
import { isGoogleConnected } from "@/lib/google/auth";
import { isMicrosoftConnected } from "@/lib/microsoft/auth";
import {
  cancelOutlookEvent,
  createOutlookCalendarEvent,
  forwardOutlookEvent,
  isOutlookEventId,
  OutlookNotAttendeeError,
  proposeOutlookNewTime,
  respondToOutlookEvent,
  updateOutlookEvent,
} from "@/lib/microsoft/outlook-calendar";
import type { CalendarProvider } from "./unified";

export { NotAnAttendeeError };

export const CALENDAR_NAME: Record<CalendarProvider, string> = { google: "Google Calendar", microsoft: "Microsoft 365 calendar" };

/** The calendar an event id belongs to. Pure. */
export function eventProvider(eventId: string): CalendarProvider {
  return isOutlookEventId(eventId) ? "microsoft" : "google";
}

/** The event's calendar is not connected (route → 401). */
export class CalendarNotConnectedError extends Error {
  constructor(public provider: CalendarProvider | null) {
    super(provider ? `${CALENDAR_NAME[provider]} not connected.` : "No calendar connected. Connect Google or Microsoft 365 in Settings.");
  }
}

async function isConnected(username: string, provider: CalendarProvider): Promise<boolean> {
  return provider === "google"
    ? isGoogleConnected(username).catch(() => false)
    : isMicrosoftConnected(username, "calendar").catch(() => false);
}

async function requireProvider(username: string, eventId: string): Promise<CalendarProvider> {
  const provider = eventProvider(eventId);
  if (!(await isConnected(username, provider))) throw new CalendarNotConnectedError(provider);
  return provider;
}

/**
 * Where a new event goes: the explicit provider if it is connected, else
 * Google if connected, else Microsoft. Null when nothing usable is connected.
 */
export async function primaryCalendar(username: string, explicit?: CalendarProvider | null): Promise<CalendarProvider | null> {
  if (explicit) return (await isConnected(username, explicit)) ? explicit : null;
  if (await isConnected(username, "google")) return "google";
  if (await isConnected(username, "microsoft")) return "microsoft";
  return null;
}

export type NewEventParams = Parameters<typeof createGoogleEvent>[1];

/** Create on `provider` (already resolved with primaryCalendar). */
export async function createEventOn(
  username: string,
  provider: CalendarProvider,
  params: NewEventParams,
): Promise<{ id: string; htmlLink: string; provider: CalendarProvider }> {
  const made = provider === "google"
    ? await createGoogleEvent(username, params)
    : await createOutlookCalendarEvent(username, params);
  return { ...made, provider };
}

export async function updateCalendarEvent(
  username: string,
  eventId: string,
  params: Parameters<typeof updateGoogleEvent>[2],
  timezone?: string,
): Promise<CalendarProvider> {
  const provider = await requireProvider(username, eventId);
  if (provider === "google") await updateGoogleEvent(username, eventId, params);
  else await updateOutlookEvent(username, eventId, params, timezone);
  return provider;
}

export async function cancelEvent(
  username: string,
  eventId: string,
  opts: { notify: boolean; note?: string },
): Promise<CancelResult & { provider: CalendarProvider }> {
  const provider = await requireProvider(username, eventId);
  const result = provider === "google" ? await cancelGoogleEvent(username, eventId, opts) : await cancelOutlookEvent(username, eventId, opts);
  return { ...result, provider };
}

export async function respondToEvent(
  username: string,
  eventId: string,
  opts: { response: RsvpResponse; comment?: string; notify?: boolean },
): Promise<RespondedEvent> {
  const provider = await requireProvider(username, eventId);
  if (provider === "google") return respondToGoogleEvent(username, eventId, opts);
  try {
    return await respondToOutlookEvent(username, eventId, opts);
  } catch (e) {
    if (e instanceof OutlookNotAttendeeError) throw new NotAnAttendeeError();
    throw e;
  }
}

/**
 * Propose a new time. Google has no API for it (Maybe + note + email to the
 * organiser, see proposeNewTime); Outlook does — its proposal reaches the
 * organiser as a real "new time proposed".
 */
export async function proposeNewTime(
  username: string,
  eventId: string,
  opts: Parameters<typeof proposeGoogleTime>[2],
): Promise<{ emailedTo?: string; comment: string }> {
  const provider = await requireProvider(username, eventId);
  if (provider === "google") return proposeGoogleTime(username, eventId, opts);

  const start = new Date(opts.start), end = new Date(opts.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new RangeError("Pick a valid start and end time.");
  if (end <= start) throw new RangeError("The proposed end must be after the start.");
  if (start.getTime() < (opts.now ?? Date.now())) throw new RangeError("The proposed time is in the past.");
  const note = opts.note ? opts.note.replace(/[\r\n]+/g, " ").trim().slice(0, 300) : "";
  const comment = `Proposed new time: ${formatSlot(opts.start, opts.end, opts.timeZone || "Europe/London")}${note ? ` — ${note}` : ""}`;
  try {
    const out = await proposeOutlookNewTime(username, eventId, { start: opts.start, end: opts.end, response: opts.response, comment });
    return { emailedTo: out.emailedTo, comment: out.comment };
  } catch (e) {
    if (e instanceof OutlookNotAttendeeError) throw new NotAnAttendeeError();
    throw e;
  }
}

export async function forwardEvent(
  username: string,
  eventId: string,
  emails: string[],
): Promise<{ summary: string; added: string[]; provider: CalendarProvider }> {
  const provider = await requireProvider(username, eventId);
  const out = provider === "google" ? await forwardGoogleEvent(username, eventId, emails) : await forwardOutlookEvent(username, eventId, emails);
  return { ...out, provider };
}
