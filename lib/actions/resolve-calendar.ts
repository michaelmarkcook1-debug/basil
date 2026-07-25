import "server-only";

import type { ActionItem } from "@/lib/types/action";

/**
 * Resolve "confirm attendance / expect invite / RSVP" commitments from the
 * calendar's own RSVP state.
 *
 * The gap this closes: ingestion CREATES a commitment from an invitation email
 * ("Confirm attendance for AnalystGenius Demo with Kyndryl stakeholders") but
 * nothing ever CLOSES it — accepting the Google Calendar invite doesn't send a
 * reply into the Gmail thread the action was synthesised from, so the existing
 * email-reply resolver never fires. The commitment sits in Upcoming forever,
 * even though the calendar plainly shows `myResponseStatus: "accepted"`.
 *
 * This module is a PURE matcher (no I/O) so the matching can be exhaustively
 * tested — it decides which open actions a given set of calendar events
 * resolves. Closing the WRONG commitment silently loses a real task, so the
 * match is deliberately strict: same due-DATE as the event AND a shared
 * DISTINCTIVE token (the meeting's other party), never title alone — every demo
 * here is generically titled "AnalystGenius Demo", so the discriminator is the
 * date + the counterparty (Kyndryl / Hitachi / PwC …).
 */

/** Minimal shape this matcher needs from a calendar event. */
export interface CalendarRsvpEvent {
  summary: string;
  /** ISO datetime; only the yyyy-mm-dd is used. */
  start: string;
  /** The user's own RSVP. */
  myResponseStatus?: "accepted" | "declined" | "tentative" | "needsAction";
  /** Attendee display names and/or raw emails. */
  attendees: string[];
}

export interface ResolvedAction {
  action: ActionItem;
  event: CalendarRsvpEvent;
  /** Why it resolved — drives the audit line + Done-list label. */
  reason: "accepted" | "declined" | "invite-arrived";
}

// Which actions are eligible. Kept tight — only invite/attendance commitments.
const CONFIRM_RE = /\bconfirm attendance\b|\brsvp\b|\baccept(?:ance)?\b.*\binvit|\bpreferred time\b|\bdecline\b.*\binvit/i;
const EXPECT_RE = /\bexpect (?:a |the )?(?:meeting )?invit/i;

// Words too generic to disambiguate WHICH meeting — never counted as a match.
const BOILERPLATE = new Set([
  "analystgenius", "demo", "meeting", "invite", "invitation", "confirm", "attendance",
  "expect", "preferred", "time", "prepare", "attend", "call", "with", "for", "from",
  "the", "and", "on", "at", "a", "an", "to", "your", "stakeholders", "stakeholder",
  "respond", "reply", "response", "session", "sync", "team", "re", "am", "pm", "ct",
  "pt", "et", "bst", "gmt", "utc", "july", "august", "june", "september",
]);

function dayOf(iso: string): string {
  return (iso || "").slice(0, 10);
}

/** Distinctive lowercase tokens (len ≥ 4, non-boilerplate) from arbitrary text. */
function distinctiveTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of (text || "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 4 && !BOILERPLATE.has(raw) && !/^\d+$/.test(raw)) out.add(raw);
  }
  return out;
}

/** The event's identity tokens: summary words + attendee names + email local
 *  parts + email domain second-level (kyndryl, globallogic, hitachids, pwc). */
function eventTokens(event: CalendarRsvpEvent): Set<string> {
  const out = distinctiveTokens(event.summary);
  for (const a of event.attendees ?? []) {
    for (const t of distinctiveTokens(a)) out.add(t);
    const at = a.indexOf("@");
    if (at > -1) {
      for (const t of distinctiveTokens(a.slice(0, at))) out.add(t); // local part
      const domain = a.slice(at + 1).split(".");
      if (domain[0] && domain[0].length >= 4 && !BOILERPLATE.has(domain[0])) out.add(domain[0]);
    }
  }
  return out;
}

/** Do the two token sets share a distinctive term? Substring-tolerant for
 *  names vs domains ("hitachi" ⊂ "hitachids"). */
function sharesDistinctiveToken(actionTokens: Set<string>, evTokens: Set<string>): boolean {
  for (const a of actionTokens) {
    if (evTokens.has(a)) return true;
    if (a.length >= 5) {
      for (const e of evTokens) {
        if (e.length >= 5 && (e.includes(a) || a.includes(e))) return true;
      }
    }
  }
  return false;
}

/**
 * Compute which open actions the given calendar events resolve.
 *
 * @param actions  the user's actions (only open ones are considered)
 * @param events   upcoming + recent calendar events with RSVP state
 */
export function resolveAttendanceActions(
  actions: ActionItem[],
  events: CalendarRsvpEvent[],
): ResolvedAction[] {
  const open = actions.filter((a) => a.status === "open");
  const resolved: ResolvedAction[] = [];

  for (const action of open) {
    const isConfirm = CONFIRM_RE.test(action.text);
    const isExpect = EXPECT_RE.test(action.text);
    if (!isConfirm && !isExpect) continue;
    // A due date is the anchor. Without one we cannot safely disambiguate which
    // meeting this is, so we leave it alone rather than risk a wrong close.
    if (!action.dueDate) continue;

    const aTokens = distinctiveTokens(action.text);
    if (aTokens.size === 0) continue; // no discriminator → never auto-close

    for (const event of events) {
      if (dayOf(event.start) !== dayOf(action.dueDate)) continue;
      if (!sharesDistinctiveToken(aTokens, eventTokens(event))) continue;

      const rsvp = event.myResponseStatus;
      if (isConfirm) {
        // Confirming attendance is satisfied by any explicit response.
        if (rsvp === "accepted" || rsvp === "declined") {
          resolved.push({ action, event, reason: rsvp });
          break;
        }
      } else {
        // "Expect an invite" is satisfied the moment the invite is on the
        // calendar at all — regardless of whether it's been answered yet.
        resolved.push({ action, event, reason: "invite-arrived" });
        break;
      }
    }
  }

  return resolved;
}
