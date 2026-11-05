/**
 * Out of office: Gmail's vacation auto-reply, plus an optional Calendar
 * "Out of office" block that declines new invitations for the same days.
 *
 * Every write is read back from Google before it is reported, so Basil can
 * show what Gmail and Calendar actually hold rather than what it asked for.
 * Before 2026-11-03 Basil had no way to do this and could only hand the user
 * instructions. Tested in tests/out-of-office.test.mjs.
 */
import { google } from "googleapis";
import { getAuthedClient, getGrantedScopes, GOOGLE_SCOPE } from "./auth";

export interface OutOfOfficeRequest {
  /** First day away, YYYY-MM-DD in `timezone`. */
  start: string;
  /** Last day away (inclusive), YYYY-MM-DD in `timezone`. */
  end: string;
  subject: string;
  message: string;
  timezone: string;
  /** Only reply to people in the user's Google contacts. */
  contactsOnly?: boolean;
  /** Only reply to people in the user's own Workspace domain. */
  domainOnly?: boolean;
  /** Also put an "Out of office" block on the calendar that declines new invites. */
  blockCalendar?: boolean;
}

/** What Google holds after the write, read back from the API. */
export interface OutOfOfficeState {
  autoReplyOn: boolean;
  subject: string | null;
  message: string | null;
  /** First and last day the auto-reply covers, YYYY-MM-DD in the user's timezone. */
  firstDay: string | null;
  lastDay: string | null;
  contactsOnly: boolean;
  domainOnly: boolean;
  calendarBlock?: { id: string; htmlLink: string | null; start: string | null; end: string | null };
}

export class OutOfOfficeScopeError extends Error {
  constructor() {
    super("Basil doesn't have permission to change Gmail's out-of-office yet. Reconnect Google in Settings (one click) and try again.");
    this.name = "OutOfOfficeScopeError";
  }
}

const DAY_MS = 86_400_000;

/** Offset of `tz` from UTC at instant `ms`, in ms (Europe/London in summer → +3_600_000). */
function tzOffsetMs(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - ms;
}

/** Epoch ms of 00:00 on `date` (YYYY-MM-DD) in `tz`. */
export function midnightIn(date: string, tz: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(first, tz); // second pass settles a DST change at midnight
}

/** YYYY-MM-DD of instant `ms` in `tz`. */
export function dayIn(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/** The auto-reply window: from the first day's midnight to the midnight after the last day. */
export function vacationWindow(start: string, end: string, tz: string): { startMs: number; endMs: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new Error("Dates must be YYYY-MM-DD.");
  if (end < start) throw new Error("The last day is before the first day.");
  const startMs = midnightIn(start, tz);
  const [y, m, d] = end.split("-").map(Number);
  const dayAfter = new Date(Date.UTC(y, m - 1, d) + DAY_MS).toISOString().slice(0, 10);
  return { startMs, endMs: midnightIn(dayAfter, tz) };
}

async function requireSettingsScope(username: string): Promise<void> {
  const scopes = await getGrantedScopes(username);
  if (scopes.length > 0 && !scopes.includes(GOOGLE_SCOPE.gmailSettings)) throw new OutOfOfficeScopeError();
}

function isScopeError(e: unknown): boolean {
  const err = e as { code?: number; status?: number; message?: string };
  return (err?.code === 403 || err?.status === 403) && /insufficient|scope|permission/i.test(err?.message ?? "");
}

function stateFrom(v: Record<string, unknown> | undefined, tz: string): OutOfOfficeState {
  const startMs = v?.startTime ? Number(v.startTime) : null;
  const endMs = v?.endTime ? Number(v.endTime) : null;
  return {
    autoReplyOn: Boolean(v?.enableAutoReply),
    subject: (v?.responseSubject as string) || null,
    message: (v?.responseBodyPlainText as string) || null,
    firstDay: startMs ? dayIn(startMs, tz) : null,
    // endTime is the midnight after the last day.
    lastDay: endMs ? dayIn(endMs - 1, tz) : null,
    contactsOnly: Boolean(v?.restrictToContacts),
    domainOnly: Boolean(v?.restrictToDomain),
  };
}

/** Read Gmail's current out-of-office setting. */
export async function getOutOfOffice(username: string, tz: string): Promise<OutOfOfficeState> {
  const auth = await getAuthedClient(username);
  if (!auth) throw new Error("Google is not connected.");
  try {
    const res = await google.gmail({ version: "v1", auth }).users.settings.getVacation({ userId: "me" });
    return stateFrom(res.data as Record<string, unknown>, tz);
  } catch (e) {
    if (isScopeError(e)) throw new OutOfOfficeScopeError();
    throw e;
  }
}

/** Turn the auto-reply on (and optionally block the calendar), then read both back. */
export async function setOutOfOffice(username: string, req: OutOfOfficeRequest): Promise<OutOfOfficeState> {
  await requireSettingsScope(username);
  const auth = await getAuthedClient(username);
  if (!auth) throw new Error("Google is not connected.");
  const { startMs, endMs } = vacationWindow(req.start, req.end, req.timezone);
  if (endMs <= Date.now()) throw new Error("Those dates are already over.");

  const gmail = google.gmail({ version: "v1", auth });
  try {
    await gmail.users.settings.updateVacation({
      userId: "me",
      requestBody: {
        enableAutoReply: true,
        responseSubject: req.subject.trim(),
        responseBodyPlainText: req.message.trim(),
        restrictToContacts: Boolean(req.contactsOnly),
        restrictToDomain: Boolean(req.domainOnly),
        startTime: String(startMs),
        endTime: String(endMs),
      },
    });
  } catch (e) {
    if (isScopeError(e)) throw new OutOfOfficeScopeError();
    throw e;
  }

  const state = await getOutOfOffice(username, req.timezone);

  if (req.blockCalendar) {
    const calendar = google.calendar({ version: "v3", auth });
    const created = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        eventType: "outOfOffice",
        summary: "Out of office",
        // Calendar requires timed (not all-day) out-of-office events.
        start: { dateTime: new Date(startMs).toISOString(), timeZone: req.timezone },
        end: { dateTime: new Date(endMs).toISOString(), timeZone: req.timezone },
        transparency: "opaque",
        outOfOfficeProperties: { autoDeclineMode: "declineOnlyNewConflictingInvitations", declineMessage: req.message.trim() },
      },
    });
    const id = created.data.id ?? "";
    const back = id ? (await calendar.events.get({ calendarId: "primary", eventId: id })).data : null;
    state.calendarBlock = {
      id,
      htmlLink: back?.htmlLink ?? null,
      start: back?.start?.dateTime ?? null,
      end: back?.end?.dateTime ?? null,
    };
  }
  return state;
}

/** Turn the auto-reply off and read it back. */
export async function clearOutOfOffice(username: string, tz: string): Promise<OutOfOfficeState> {
  await requireSettingsScope(username);
  const auth = await getAuthedClient(username);
  if (!auth) throw new Error("Google is not connected.");
  try {
    await google.gmail({ version: "v1", auth }).users.settings.updateVacation({ userId: "me", requestBody: { enableAutoReply: false } });
  } catch (e) {
    if (isScopeError(e)) throw new OutOfOfficeScopeError();
    throw e;
  }
  return getOutOfOffice(username, tz);
}
