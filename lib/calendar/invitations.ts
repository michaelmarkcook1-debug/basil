/** Pure invitation helpers — shared by Today's panel and tests. */

export interface InvitationLike {
  end: string;
  start?: string;
  /** The repeating meeting this occurrence belongs to, when it repeats. */
  seriesId?: string;
  isOrganizer?: boolean;
  myResponseStatus?: "accepted" | "declined" | "tentative" | "needsAction";
}

/** Someone else's invitation you haven't answered, for a meeting that hasn't ended. */
export function needsAnswer(e: InvitationLike, now = Date.now()): boolean {
  return !e.isOrganizer && e.myResponseStatus === "needsAction" && Date.parse(e.end) > now;
}

/**
 * The invitations that really are waiting on you. needsAnswer() looks at one
 * occurrence; this looks across them. A date of a repeating meeting you have
 * already said yes or maybe to elsewhere in the window is not a new invitation
 * — Google keeps each occurrence's answer separately, and an organiser editing
 * the series resets some to "not answered" (Ed's GTM standup, 2026-11-23: 25 Nov
 * maybe, 30 Nov yes, 2 and 4 Dec shown as invitations). A series answered
 * nowhere shows once, at its first date, not once per date.
 */
export function pendingInvitations<T extends InvitationLike>(events: readonly T[], now = Date.now()): T[] {
  const answered = new Set(events
    .filter((e) => e.seriesId && (e.myResponseStatus === "accepted" || e.myResponseStatus === "tentative"))
    .map((e) => e.seriesId as string));
  const shown = new Set<string>();
  const out: T[] = [];
  for (const e of [...events].sort((a, b) => (a.start ?? a.end).localeCompare(b.start ?? b.end))) {
    if (!needsAnswer(e, now)) continue;
    if (e.seriesId) {
      if (answered.has(e.seriesId) || shown.has(e.seriesId)) continue;
      shown.add(e.seriesId);
    }
    out.push(e);
  }
  return out;
}
