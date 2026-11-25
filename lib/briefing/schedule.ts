/**
 * lib/briefing/schedule.ts — when each user's morning briefing is written
 * (audit 2026-11-24, Part 3 entry 11). Pure.
 *
 * It ran at 06:15 UTC for everyone: 06:15 in London in winter, 01:15 in New
 * York, the afternoon in Sydney. Now the cron runs hourly and writes a user's
 * briefing an hour before their working day starts (08:00 for a 09:00 start,
 * never before 05:00), in their time zone. If that run fails, the next two
 * hours try again; once today's briefing exists, nothing more is written.
 */
import { startHour } from "@/lib/notify/rules";

/** The local hour the briefing is written: an hour before work starts, 05:00 at the earliest. */
export function briefingHour(workStart: string | undefined): number {
  return Math.max(5, startHour(workStart) - 1);
}

/** The cron should write it now: at the briefing hour or up to two hours later (retries). */
export function briefingDueNow(localHour: number, workStart: string | undefined): boolean {
  const h = briefingHour(workStart);
  return localHour >= h && localHour < h + 3;
}

/** A briefing generated at `generatedAt` already covers local day `today`. */
export function alreadyWrittenToday(generatedAt: string | undefined, today: string, tz: string): boolean {
  if (!generatedAt) return false;
  const t = Date.parse(generatedAt);
  return Number.isFinite(t) && new Date(t).toLocaleDateString("en-CA", { timeZone: tz }) === today;
}

/** Briefings that describe a single day. Weekly and meeting briefings keep their own expiry. */
const DAILY_BRIEFINGS = new Set(["morning", "midday", "evening"]);

/**
 * A cached briefing may be shown now. A daily one must have been written today
 * in the user's time zone: it was cached for a rolling 24 hours, so until the
 * 08:00 run the home led with yesterday's briefing under today's date
 * (2026-11-25: Tuesday's 17:00 clash shown on Wednesday morning).
 */
export function briefingIsCurrent(type: string, generatedAt: string | undefined, tz: string, now: number = Date.now()): boolean {
  if (!DAILY_BRIEFINGS.has(type)) return true;
  return alreadyWrittenToday(generatedAt, new Date(now).toLocaleDateString("en-CA", { timeZone: tz }), tz);
}
