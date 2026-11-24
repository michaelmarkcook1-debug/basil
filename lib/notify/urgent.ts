/**
 * lib/notify/urgent.ts — push an urgent message the moment it becomes an
 * action (audit 2026-11-24, Part 3 entry 10). The rules are in
 * lib/notify/urgent-rules.ts. Never throws: a failed push must not fail ingestion.
 */
import "server-only";
import { getSettings } from "@/lib/settings/store";
import { getWorkCalendar } from "@/lib/away/store";
import { awayStatus } from "@/lib/away/calendar";
import { getNotifyState, notifyUser, type NotifyOutcome } from "@/lib/notify/index";
import { DAILY_CAP, inWorkingHours, isFresh, isUrgent, urgentNotification, type UrgentSignal } from "@/lib/notify/urgent-rules";

export type UrgentOutcome = NotifyOutcome | { skipped: "not-urgent" | "stale" | "off-hours" | "away" | "daily-cap" | "error" };

export async function pushIfUrgent(username: string, s: UrgentSignal, now = Date.now()): Promise<UrgentOutcome> {
  try {
    if (!isUrgent(s)) return { skipped: "not-urgent" };
    if (!isFresh(s.date, now)) return { skipped: "stale" };
    const settings = await getSettings(username);
    const tz = settings.timezone || "Europe/London";
    if (!inWorkingHours(now, tz, settings.workStart, settings.workEnd)) return { skipped: "off-hours" };
    const today = new Date(now).toLocaleDateString("en-CA", { timeZone: tz });
    const cal = await getWorkCalendar(username, { refresh: "never" }).catch((e) => {
      console.warn("[notify/urgent] working calendar unreadable, treating today as a working day:", e instanceof Error ? e.message : e);
      return null;
    });
    if (cal) {
      const st = awayStatus(today, cal).state;
      if (st === "away" || st === "non-working") return { skipped: "away" };
    }
    const state = await getNotifyState(username);
    const sentToday = Object.keys(state.sent).filter((k) => k.startsWith(`urgent:${today}:`)).length;
    if (sentToday >= DAILY_CAP) return { skipped: "daily-cap" };
    const out = await notifyUser(username, urgentNotification(s), { onceKeys: [`urgent:${today}:${s.ref}`] });
    if (out.pushed > 0) console.log(`[notify/urgent] ${username}: pushed ${s.source} ${s.ref}`);
    return out;
  } catch (e) {
    console.warn("[notify/urgent] skipped after an error:", e instanceof Error ? e.message : e);
    return { skipped: "error" };
  }
}
