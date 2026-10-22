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
 * Days an AUTO-EXTRACTED action may sit untouched before it is archived. By then
 * the conversation it came from has moved on; 277 of 362 open actions on
 * 2026-09-26 had not been touched in 90+ days and buried the live ones.
 */
export const UNTOUCHED_ARCHIVE_DAYS = 30;

const AUTO_SOURCES = new Set(["email", "slack", "teams", "meeting"]);

/**
 * Auto-extracted (email/Slack/Teams/meeting), still open, no due date still
 * ahead, and no activity for UNTOUCHED_ARCHIVE_DAYS. Anything the user created
 * (manual, chat) or that syncs from a system of record (linear) is never
 * archived for age. Archiving sets status "done" with a reason — recoverable.
 */
export function isUntouchedStale(action: ActionItem, now = Date.now()): boolean {
  if (action.status !== "open" && action.status !== "overdue") return false;
  if (!AUTO_SOURCES.has(action.source)) return false;
  if (action.dueDate && new Date(action.dueDate).getTime() >= now) return false;
  const lastTouch = action.lastActivityAt ?? action.createdAt;
  return now - new Date(lastTouch).getTime() >= UNTOUCHED_ARCHIVE_DAYS * 86_400_000;
}

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
  // Synthesized invite-response actions ("Respond to scheduling request from X
  // re: 'Invitation: … @ Fri Jul 3, 2026'"). Once the event date (= the
  // action's dueDate, set at ingest from the subject) has passed, responding is
  // exactly as moot as attending — without this, expired invite-responses sat
  // in the open list forever (observed: 5 of 9 Olivia scheduling rows referred
  // to events that had already happened).
  /^respond to scheduling request\b/i,
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

// ── Whose action is it? ──────────────────────────────────────────────────────
//
// Every action records an owner, but nothing used it to decide whose list it
// belongs on: on 2026-10-13 two Zoom recaps filed Carter's "send the brochure
// to Michael" and Roger's "update AI Enterprise cache rules" as Michael's open
// actions (11 → 33 open in four days). Someone else's commitment is something
// you are WAITING ON — tracked, but not on your list or in your counts.

const SELF_OWNERS = new Set(["", "me", "you", "myself", "i"]);

/**
 * True when the action belongs to someone else. `selfNames` are the user's
 * names ("Michael Cook", "Michael"); with none known, nothing is assumed to
 * be someone else's — better to show an action than to hide one.
 */
export function isWaitingOnOthers(action: { owner?: string }, selfNames: readonly string[]): boolean {
  const owner = (action.owner ?? "").trim().toLowerCase();
  if (SELF_OWNERS.has(owner) || selfNames.length === 0) return false;
  const names = selfNames.map((n) => n.trim().toLowerCase()).filter(Boolean);
  if (names.includes(owner)) return false;
  const firsts = new Set(names.map((n) => n.split(/\s+/)[0]));
  return !firsts.has(owner.split(/\s+/)[0]);
}

/**
 * A meeting note ("Follow up: …", "Blocker: …", a decision's consequence)
 * → whose task it is. The user's when it names them; a named person's when it
 * reads "<Name> to/will …"; otherwise nobody's — it stays a meeting note, not
 * an action. Pure — exported for tests.
 */
const NOT_A_NAME = /^(?:need|needs|plan|plans|want|wants|try|continue|decide|decided|remember|agree|agreed|aim|ask|asked|time|going|ready|able|due|unable|likely|team|someone|everyone|nobody|all|both|we|they|it|this|that|there|next|then|also|still|consider|explore|review|follow|confirm)$/i;

export function ownerOfMeetingNote(text: string, selfNames: readonly string[]): { owner: string } | null {
  const body = text.replace(/^\s*(follow[- ]?up|blocker)\s*:\s*/i, "");
  // Ownership is the note's SUBJECT doing something — "<Name> to/will …" or
  // "Michael owns this" — never a mention. "Matthew to send screenshots to
  // Michael Cook" is Matthew's; it used to be filed as the user's because the
  // user's name appeared anywhere in it (seen 2026-10-14).
  const VERB = "(?:to|will|'ll|should|must|needs to|has to|is to|owns)";
  const firsts = selfNames.map((n) => n.trim().split(/\s+/)[0]).filter(Boolean);
  const isSelf = (name: string) => firsts.some((f) => f.toLowerCase() === name.split(/\s+/)[0].toLowerCase());
  // Second word may be an initial: "Mike C to send…".
  const named = new RegExp(`^\\s*([A-Z][a-z]+(?:\\s+[A-Z](?:[a-z]+|\\.)?)?)\\s+${VERB}\\b`).exec(body);
  // "Need to learn more…", "Plan to…": a capitalised word before "to" is not
  // always a person. Seen 2026-10-22: two blockers were filed under "Need".
  if (named && NOT_A_NAME.test(named[1].split(/\s+/)[0])) return null;
  if (named) return isSelf(named[1]) ? { owner: selfNames[0] ?? named[1] } : { owner: named[1] };
  for (const f of firsts) {
    const esc = f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${esc}(?:\\s+[A-Z][a-z]+)?\\s+${VERB}\\b`, "i").test(body)) return { owner: selfNames[0] ?? f };
  }
  if (/^\s*(you|i)\b/i.test(body)) return { owner: selfNames[0] ?? "me" };
  return null;
}
