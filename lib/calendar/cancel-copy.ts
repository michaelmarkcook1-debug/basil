/**
 * The words on the cancel dialog (components/calendar/cancel-meeting.tsx):
 * which button, and exactly who will hear. Pure — tested in
 * tests/calendar-cancel.test.mjs.
 */

export interface CancellableEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  isOrganizer?: boolean;
  attendees?: string[];
  organizerName?: string;
  organizerEmail?: string;
  recurring?: boolean;
}

/** What the button and the explanation say. Pure — exported for tests. */
export function cancelCopy(e: CancellableEvent): { title: string; action: string; tell: string | null; noteHint: string } {
  const guests = e.attendees ?? [];
  if (e.isOrganizer) {
    const who = guests.length === 0 ? null
      : guests.length <= 3 ? guests.join(", ")
      : `${guests.slice(0, 3).join(", ")} and ${guests.length - 3} more`;
    return {
      title: "Cancel this meeting?",
      action: "Cancel meeting",
      tell: who && `Send ${guests.length === 1 ? "the guest" : `all ${guests.length} guests`} a cancellation (${who})`,
      noteHint: "Add a note (optional) — sent to the guests as an email from you",
    };
  }
  const organiser = e.organizerName || e.organizerEmail;
  return {
    title: "Decline and remove?",
    action: "Decline and remove",
    tell: organiser ? `Tell ${organiser} you're not coming` : null,
    noteHint: `Add a note to ${organiser || "the organiser"} (optional)`,
  };
}

