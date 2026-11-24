/**
 * lib/notify/premeeting-rules.ts — the nudge before an external meeting
 * (audit 2026-11-24, Part 3 entry 12). Pure; app/api/cron/premeeting sends.
 *
 * A meeting with anyone from outside the user's own company, starting in the
 * next 10–30 minutes (the cron runs every 10, so each meeting is caught about
 * 20 minutes ahead), gets one push linking to its prep page. Declined,
 * all-day, "free" and focus/out-of-office blocks never nudge.
 */
import type { CalendarEvent } from "@/lib/google/calendar";

export const LEAD_MIN_MS = 10 * 60_000;
export const LEAD_MAX_MS = 30 * 60_000;

const domainOf = (email: string) => email.split("@")[1]?.trim().toLowerCase() ?? "";

/** People on the invite from outside the user's own domains. */
export function externalAttendees(e: CalendarEvent, ownDomains: ReadonlySet<string>): Array<{ name: string; email: string }> {
  return (e.attendeeDetails ?? []).filter((a) => {
    const d = domainOf(a.email);
    return d && !ownDomains.has(d) && !/(^|\.)resource\.calendar\.google\.com$/.test(d);
  });
}

/** Meetings to nudge about now. */
export function meetingsToNudge(events: readonly CalendarEvent[], ownDomains: ReadonlySet<string>, now = Date.now()): Array<{ event: CalendarEvent; external: Array<{ name: string; email: string }> }> {
  const out: Array<{ event: CalendarEvent; external: Array<{ name: string; email: string }> }> = [];
  for (const e of events) {
    if (e.isAllDay || e.transparent || e.myResponseStatus === "declined") continue;
    if (e.eventType && e.eventType !== "default") continue;
    const lead = Date.parse(e.start) - now;
    if (!(lead > LEAD_MIN_MS && lead <= LEAD_MAX_MS)) continue;
    const external = externalAttendees(e, ownDomains);
    if (external.length) out.push({ event: e, external });
  }
  return out;
}

export function nudgeKey(e: CalendarEvent): string {
  return `premeeting:${e.id}:${e.start}`;
}

export function nudgeNotification(e: CalendarEvent, external: ReadonlyArray<{ name: string; email: string }>, now = Date.now()): { kind: "meetings"; title: string; body: string; url: string; tag: string } {
  const mins = Math.max(1, Math.round((Date.parse(e.start) - now) / 60_000));
  const who = external.slice(0, 3).map((a) => a.name || a.email).join(", ") + (external.length > 3 ? ` +${external.length - 3}` : "");
  const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
  return {
    kind: "meetings",
    title: clip(`In ${mins} min: ${e.summary || "Meeting"}`, 80),
    body: clip(`With ${who}. Tap for the prep: who they are, what's open, how to land it.`, 160),
    url: `/dashboard/meetings/${encodeURIComponent(e.id)}`,
    tag: `premeeting:${e.id}`,
  };
}
