/**
 * lib/modes/suggest.ts — when to offer Meeting Mode.
 *
 * Pure so it can be tested without React: given the upcoming events and the
 * clock, is a meeting *with other people* about to start? Blocks with nobody
 * else on them (focus time, lunch) are not meetings; all-day events are not
 * meetings; and a suggestion the user dismissed stays dismissed for that event.
 */
import type { MeetingSuggestion } from "./types";

export interface UpcomingEvent {
  id: string;
  summary: string;
  start: string;
  attendeeCount: number;
  isAllDay?: boolean;
}

/** Minutes either side of the start time in which the offer makes sense. */
export const SUGGEST_WINDOW_MIN = 5;

export function findMeetingSuggestion(
  events: ReadonlyArray<UpcomingEvent> | undefined,
  nowMs: number,
  activeMode: string,
  dismissedEventId: string | null,
): MeetingSuggestion | null {
  if (activeMode === "meeting") return null;
  for (const e of events ?? []) {
    if (e.isAllDay || !(e.attendeeCount > 0) || !e.start) continue;
    const startsInMin = Math.round((new Date(e.start).getTime() - nowMs) / 60_000);
    if (startsInMin > SUGGEST_WINDOW_MIN || startsInMin < -SUGGEST_WINDOW_MIN) continue;
    if (dismissedEventId === e.id) return null;
    return { eventId: e.id, summary: e.summary, startsInMin, attendeeCount: e.attendeeCount };
  }
  return null;
}
