/**
 * Where a meeting stands, for the Calendar page (app/dashboard/meetings).
 *
 * Anything but "meeting" (settled) or "declined" is not yet accepted: an
 * invitation you haven't answered, one you said maybe to, or your own meeting
 * where no guest has said yes yet. Pure — shared by the four-day graphic and
 * the meeting cards, and tested in tests/calendar-cancel.test.mjs.
 */

export type MeetingState = "meeting" | "invite" | "tentative" | "awaiting" | "declined";

export interface MeetingStateInput {
  myResponseStatus?: "accepted" | "declined" | "tentative" | "needsAction";
  isOrganizer?: boolean;
  guests?: { total: number; accepted: number; tentative: number; declined: number; waiting: number };
}

export function meetingState(e: MeetingStateInput): MeetingState {
  if (e.myResponseStatus === "declined") return "declined";
  if (!e.isOrganizer && e.myResponseStatus === "needsAction") return "invite";
  if (!e.isOrganizer && e.myResponseStatus === "tentative") return "tentative";
  const g = e.guests;
  if (e.isOrganizer && g && g.total > 0 && g.accepted + g.tentative === 0 && g.waiting > 0) return "awaiting";
  return "meeting";
}

export type PillTone = "invite" | "maybe" | "waiting" | "declined";

/** The flag on a meeting card, or null when there is nothing to flag. */
export function statePill(e: MeetingStateInput): { text: string; tone: PillTone } | null {
  const kind = meetingState(e);
  if (kind === "invite") return { text: "Not answered", tone: "invite" };
  if (kind === "tentative") return { text: "You said maybe", tone: "maybe" };
  if (kind === "declined") return { text: "You declined", tone: "declined" };
  const g = e.guests;
  if (e.isOrganizer && g && g.waiting > 0) {
    if (kind === "awaiting") return { text: g.total === 1 ? "Guest hasn't accepted" : `No one has accepted yet (${g.total})`, tone: "waiting" };
    return { text: `${g.waiting} of ${g.total} haven't replied`, tone: "waiting" };
  }
  return null;
}
