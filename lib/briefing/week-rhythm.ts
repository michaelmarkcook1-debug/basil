/**
 * lib/briefing/week-rhythm.ts — the Monday plan and the Friday wrap (audit
 * 2026-11-24, Part 3 entry 15). Pure; app/api/cron/reminders sends.
 *
 * On the first working day of the user's week, at the start of the day, a
 * push opens the weekly briefing (the week ahead). On the last working day,
 * an hour before the day ends, a push opens the evening wrap with the backlog
 * of items untouched for 30+ days to clear. "First" and "last" follow the
 * user's working calendar: a Monday bank holiday moves the plan to Tuesday,
 * a Friday off moves the wrap to Thursday. Both briefings are written only
 * when the user opens them — the pushes cost no AI.
 */
import { addDays, isAvailableDay, nextAvailableDay, previousAvailableDay, weekdayOf } from "@/lib/away/calendar";
import type { WorkCalendar } from "@/lib/away/calendar";

/** Monday of the ISO week a day is in. */
export function weekStart(day: string): string {
  return addDays(day, -((weekdayOf(day) + 6) % 7));
}

export function isFirstWorkingDayOfWeek(today: string, cal: WorkCalendar): boolean {
  return isAvailableDay(today, cal) && weekStart(previousAvailableDay(today, cal)) !== weekStart(today);
}

export function isLastWorkingDayOfWeek(today: string, cal: WorkCalendar): boolean {
  return isAvailableDay(today, cal) && weekStart(nextAvailableDay(today, cal)) !== weekStart(today);
}

/** "18:00" → 17: the wrap goes an hour before the working day ends. */
export function wrapHour(workEnd: string | undefined): number {
  const m = /^(\d{1,2})(?::\d{2})?$/.exec((workEnd ?? "").trim());
  const h = m ? Number(m[1]) : 18;
  return Math.max(0, (Number.isInteger(h) && h >= 1 && h <= 23 ? h : 18) - 1);
}

export function mondayPlanNotification(c: { dueThisWeek: number; waiting: number }): { kind: "weekly"; title: string; body: string; url: string; tag: string } {
  const bits = [
    c.dueThisWeek ? `${c.dueThisWeek} commitment${c.dueThisWeek === 1 ? "" : "s"} due this week` : "",
    c.waiting ? `${c.waiting} waiting on others` : "",
  ].filter(Boolean);
  return {
    kind: "weekly",
    title: "Plan your week",
    body: `${bits.length ? `${bits.join(", ")}. ` : ""}Tap for the week ahead: priorities, key meetings, what's drifting.`,
    url: "/dashboard/briefing?type=weekly&auto=1",
    tag: "basil-week-plan",
  };
}

export function fridayWrapNotification(c: { doneThisWeek: number; backlog: number }): { kind: "weekly"; title: string; body: string; url: string; tag: string } {
  return {
    kind: "weekly",
    title: "Your week, wrapped",
    body: `${c.doneThisWeek} done this week.${c.backlog ? ` ${c.backlog} item${c.backlog === 1 ? "" : "s"} untouched for 30+ days to clear in a tap each.` : ""} Tap for the wrap and what to set up for next week.`,
    url: "/dashboard/briefing?type=evening&auto=1",
    tag: "basil-week-wrap",
  };
}
