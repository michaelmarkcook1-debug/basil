/**
 * lib/pipedrive/followups-server.ts — follow-up suggestions for a user, and
 * finding / booking a follow-up meeting (opt-in "schedule" mode only).
 */
import "server-only";
import { getSettings } from "@/lib/settings/store";
import { dayIn } from "@/lib/away/calendar";
import { readCalendar, connectedCalendars, windowBounds } from "@/lib/calendar/unified";
import { fetchAndFindSlots, type SlotSuggestion } from "@/lib/calendar/find-slots";
import { createEventOn, primaryCalendar } from "@/lib/calendar/writes";
import { getPipedriveSnapshot, getStoredPipedriveSnapshot, type PipedriveSnapshot } from "@/lib/pipedrive/client";
import { suggestFollowups, inviteAgenda, type FollowupSuggestion } from "@/lib/pipedrive/followups";
import { readAutomation, updateAutomation, type PipedriveAutomation } from "@/lib/pipedrive/automation";

export interface FollowupState {
  automation: PipedriveAutomation;
  snapshot: PipedriveSnapshot | null;
  suggestions: FollowupSuggestion[];
  today: string;
  timezone: string;
}

/** Suggestions from the stored snapshot (no Pipedrive call unless there is no copy yet). */
export async function followupState(username: string, opts: { storedOnly?: boolean } = {}): Promise<FollowupState> {
  const [automation, settings] = await Promise.all([
    readAutomation(username),
    getSettings(username).catch((e) => { console.warn("[pipedrive/followups] settings unreadable:", e instanceof Error ? e.message : e); return null; }),
  ]);
  const timezone = settings?.timezone || "Europe/London";
  const today = dayIn(Date.now(), timezone);
  const snapshot = opts.storedOnly ? await getStoredPipedriveSnapshot(username) : await getPipedriveSnapshot(username);
  const suggestions = snapshot && automation.mode !== "off"
    ? suggestFollowups(snapshot, { today, staleDays: automation.staleDays, dismissed: automation.dismissed })
        .filter((s) => !automation.booked[s.id])
    : [];
  return { automation, snapshot, suggestions, today, timezone };
}

export class FollowupError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

async function find(username: string, id: string): Promise<FollowupState & { sug: FollowupSuggestion }> {
  const st = await followupState(username);
  if (st.automation.mode !== "schedule") throw new FollowupError("Turn on “Find a time and book” in Settings → Pipedrive first.", 403);
  const sug = st.suggestions.find((s) => s.id === id);
  if (!sug) throw new FollowupError("That follow-up is no longer suggested — it may have been booked, dismissed or done.", 404);
  return { ...st, sug };
}

const hours = (v: string | undefined, fallback: number) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v ?? "");
  return m ? Number(m[1]) + Number(m[2]) / 60 : fallback;
};

/** Free slots over the next five working days, from both calendars. */
export async function followupSlots(username: string, id: string): Promise<{ suggestion: FollowupSuggestion; slots: SlotSuggestion[]; minutes: number; attendeeChecked: boolean }> {
  const { sug, automation, timezone, today } = await find(username, id);
  const settings = await getSettings(username).catch(() => null); // ci-ok: working hours fall back to 09:00–17:00
  const connected = await connectedCalendars(username);
  if (connected.length === 0) throw new FollowupError("No calendar is connected, so Basil can't find a time.", 409);
  const range = { from: today, to: new Date(Date.parse(`${today}T00:00:00Z`) + 8 * 86_400_000).toISOString().slice(0, 10) };
  const mine = await readCalendar(username, range, timezone, { providers: connected });
  if (mine.degraded.length > 0) throw new FollowupError("Your calendar couldn't be read just now, so Basil won't guess a free time. Try again shortly.", 503);
  const { startMs, endMs } = windowBounds(range, timezone);
  const slots = await fetchAndFindSlots(username, {
    attendees: sug.contactEmail ? [{ name: sug.contactName ?? sug.contactEmail, email: sug.contactEmail }] : [],
    durationMin: automation.meetingMinutes,
    windowStart: new Date(Math.max(startMs, Date.now() + 2 * 3_600_000)),
    windowEnd: new Date(endMs),
    userBusy: mine.events.filter((e) => !e.isAllDay && e.myResponseStatus !== "declined").map((e) => ({ start: e.start, end: e.end })),
    userTimezone: timezone,
    ownerWorkStart: hours(settings?.workStart, 9),
    ownerWorkEnd: hours(settings?.workEnd, 17),
    maxSlots: 6,
  });
  return { suggestion: sug, slots, minutes: automation.meetingMinutes, attendeeChecked: !!sug.contactEmail };
}

/** Book the follow-up at `start` (one of the offered slots). Sends the invite to the contact. */
export async function bookFollowup(username: string, id: string, start: string): Promise<{ eventId: string; htmlLink: string; prepUrl: string }> {
  const { sug, automation, timezone } = await find(username, id);
  const startMs = Date.parse(start);
  if (!Number.isFinite(startMs) || startMs < Date.now()) throw new FollowupError("Pick one of the offered times.");
  const provider = await primaryCalendar(username);
  if (!provider) throw new FollowupError("No calendar is connected.", 409);
  const date = dayIn(startMs, timezone);
  const startTime = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(startMs);
  const made = await createEventOn(username, provider, {
    title: `Follow-up: ${sug.dealTitle ?? sug.orgName ?? sug.contactName ?? "client"}`,
    attendees: sug.contactEmail ? [sug.contactEmail] : [],
    date,
    startTime,
    duration: automation.meetingMinutes,
    addVideoCall: true,
    // Only the agenda goes in the invite the client sees; the CRM detail is in
    // Basil's meeting prep for this event (attendee → Pipedrive record).
    description: inviteAgenda(sug),
    timezone,
  });
  await updateAutomation(username, (c) => ({ booked: { ...c.booked, [id]: { eventId: made.id, at: new Date().toISOString(), start } } }));
  console.log(`[pipedrive/followups] ${username} booked ${id} → ${made.provider} event ${made.id} at ${start}`);
  return { eventId: made.id, htmlLink: made.htmlLink, prepUrl: `/dashboard/meetings/${encodeURIComponent(made.id)}` };
}

export async function dismissFollowup(username: string, id: string): Promise<void> {
  await updateAutomation(username, (c) => ({ dismissed: { ...c.dismissed, [id]: new Date().toISOString() } }));
}
