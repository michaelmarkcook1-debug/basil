/**
 * Pure action utilities — no server-only imports.
 * Safe to use in both server code and client components.
 */

import type { ActionItem } from "@/lib/types/action";

/** Days without activity before an open, undated action is considered stalled. */
export const STALE_THRESHOLD_DAYS = 14;

/**
 * Returns true if the action has been open with no meaningful activity for
 * STALE_THRESHOLD_DAYS or more. Items with a dueDate are either "overdue" or
 * "upcoming" — stale only applies to undated open items that have gone quiet.
 */
export function isActionStalled(action: ActionItem): boolean {
  if (action.status !== "open") return false;
  if (action.dueDate) return false; // due date items are overdue or upcoming

  const lastTouch = action.lastActivityAt ?? action.updatedAt ?? action.createdAt;
  const created = action.createdAt;
  const msElapsed = (ts: string) => Date.now() - new Date(ts).getTime();
  const cutoff = STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

  // Both "last touched" AND "created" must be past the threshold — prevents
  // freshly created actions from appearing stalled on day one.
  return msElapsed(lastTouch) >= cutoff && msElapsed(created) >= cutoff;
}
