/**
 * Pure action utilities — no server-only imports.
 * Safe to use in both server code and client components.
 */

import type { ActionItem } from "@/lib/types/action";

/** Days without activity before an open, undated action is considered stalled. */
export const STALE_THRESHOLD_DAYS = 14;

/**
 * Days past due before an overdue item with no manual updates is auto-archived.
 * These are typically auto-extracted Slack/email commitments that were never
 * acted on and whose window has long closed.
 */
export const STALE_OVERDUE_THRESHOLD_DAYS = 14;

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

/**
 * Returns true if an overdue action has gone unacknowledged long enough that
 * its original window has clearly closed.
 *
 * Criteria (all must be true):
 *   - status is "overdue" (or open with a past dueDate)
 *   - dueDate is more than STALE_OVERDUE_THRESHOLD_DAYS in the past
 *   - the item was never manually updated after creation (≤1 hour diff)
 *
 * Auto-extracted Slack/email commitments with a specific dueDate that was
 * never acknowledged qualify; manually created items that the user has
 * touched do not.
 */
export function isOverdueStale(action: ActionItem): boolean {
  const isOverdue =
    action.status === "overdue" ||
    (action.status === "open" && !!action.dueDate);
  if (!isOverdue || !action.dueDate) return false;

  const daysPastDue =
    (Date.now() - new Date(action.dueDate).getTime()) / 86_400_000;
  if (daysPastDue < STALE_OVERDUE_THRESHOLD_DAYS) return false;

  // Item was never touched after initial creation (within 1 hour)
  const lastTouch = action.lastActivityAt ?? action.updatedAt ?? action.createdAt;
  const ageOfTouchMs =
    new Date(lastTouch).getTime() - new Date(action.createdAt).getTime();
  return ageOfTouchMs < 3_600_000; // < 1 hour → never manually updated
}

/**
 * Hours after a meeting's scheduled time before a meeting-attendance action
 * is auto-archived. Chosen to be larger than any realistic meeting duration
 * while still retiring the action on the same calendar day.
 */
export const MEETING_ATTENDANCE_GRACE_HOURS = 6;

/**
 * Patterns that identify a "meeting attendance" action — an action whose only
 * purpose is to show up to a specific event. Once the meeting time has passed
 * (+ grace period) these are meaningless regardless of whether the user
 * checked them off. They are distinct from pre-meeting prep actions
 * ("prepare for…", "send agenda for…") or post-meeting follow-ups.
 */
const MEETING_ATTENDANCE_PATTERNS = [
  /^attend\b/i,
  /^join\b.*(meeting|call|standup|stand-up|sync|check-in|1:1|one-on-one)/i,
  /^(be at|show up to|dial.?into)\b/i,
  /\bmeet(ing)?\s+with\b/i,
  /\b(call|sync|standup|stand-up|check-in|1:1|one-on-one|catch-?up)\s+with\b/i,
];

/**
 * Returns true if the action text looks like a "show up to this meeting" type
 * of action — one that becomes irrelevant as soon as the scheduled time passes.
 *
 * Deliberately conservative: prep actions ("prepare for", "send agenda"),
 * outcome actions ("follow up after"), and general meeting references are
 * NOT flagged.
 */
export function isMeetingAttendanceAction(text: string): boolean {
  const t = text.trim();
  return MEETING_ATTENDANCE_PATTERNS.some((re) => re.test(t));
}

/**
 * Returns true if this is a meeting-attendance action whose scheduled time has
 * passed by more than MEETING_ATTENDANCE_GRACE_HOURS.
 *
 * Only fires when the action has a dueDate — undated meeting mentions are not
 * auto-archived because we can't determine when (or if) the meeting occurred.
 */
export function isMeetingAttendancePast(action: ActionItem): boolean {
  if (action.status === "done") return false;
  if (!action.dueDate) return false;
  if (!isMeetingAttendanceAction(action.text)) return false;

  const dueMs = new Date(action.dueDate).getTime();
  const graceMs = MEETING_ATTENDANCE_GRACE_HOURS * 3_600_000;
  return Date.now() > dueMs + graceMs;
}

/**
 * Returns true if the action's owner field is clearly a group, channel, or
 * team rather than a named individual.
 *
 * Used to exclude auto-extracted group commitments that were mistakenly stored
 * as personal actions (e.g., Slack channel-wide announcements).
 */
export function isGroupOwner(owner: string | undefined): boolean {
  if (!owner?.trim()) return false;
  const o = owner.trim().toLowerCase();
  return (
    o.startsWith("#") ||           // Slack channel: #dev-team, #general
    o.startsWith("@") ||           // Mention: @team, @channel
    o === "team" ||
    o === "the team" ||
    o.endsWith(" team") ||         // "dev team", "eng team", "product team"
    o.includes(" team ") ||
    o === "everyone" ||
    o === "all" ||
    o === "group" ||
    o === "channel" ||
    o === "the channel"
  );
}
