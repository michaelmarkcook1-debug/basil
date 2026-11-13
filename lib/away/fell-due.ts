/**
 * Commitments that fell due while the user was away — pure, so Today can count
 * them and the re-date route can move exactly the same set.
 */
import type { ActionItem } from "@/lib/types/action";
import { isWaitingOnOthers } from "@/lib/actions/utils";
import { addDays, nextAvailableDay, type AwayPeriod, type WorkCalendar } from "./calendar";

/** The user's own open commitments due on a day from the absence's first day up to yesterday. */
export function fellDueWhileAway(
  actions: ReadonlyArray<ActionItem>,
  period: Pick<AwayPeriod, "start">,
  today: string,
  selfNames: string[],
): ActionItem[] {
  const yesterday = addDays(today, -1);
  return actions.filter((a) => {
    if (a.status !== "open" && a.status !== "overdue") return false;
    if (!a.dueDate) return false;
    const due = a.dueDate.slice(0, 10);
    if (due < period.start || due > yesterday) return false;
    return !isWaitingOnOthers(a, selfNames);
  });
}

/** Where re-dated commitments go: the third working day from today, so the first day back is not a pile. */
export function suggestedRedateDay(today: string, cal: WorkCalendar): string {
  let d = today;
  for (let i = 0; i < 3; i++) d = nextAvailableDay(d, cal);
  return d;
}
