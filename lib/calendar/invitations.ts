/** Pure invitation helpers — shared by Today's panel and tests. */

export interface InvitationLike {
  end: string;
  isOrganizer?: boolean;
  myResponseStatus?: "accepted" | "declined" | "tentative" | "needsAction";
}

/** Someone else's invitation you haven't answered, for a meeting that hasn't ended. */
export function needsAnswer(e: InvitationLike, now = Date.now()): boolean {
  return !e.isOrganizer && e.myResponseStatus === "needsAction" && Date.parse(e.end) > now;
}
