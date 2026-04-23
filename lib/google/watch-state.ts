/**
 * Persists Gmail + Calendar watch-channel state via the shared store so it
 * survives Vercel cold starts (included in the BASIL_DATA snapshot).
 *
 * Previously used node:fs directly against process.cwd()/.data, which is
 * read-only on Vercel Fluid Compute. Migrated to readStore/writeStore which
 * resolve to /tmp/basil-data on Vercel and .data/ in local dev.
 */

import { readStore, writeStore } from "@/lib/storage/persistent";

const WATCH_FILE = "google-watch.json";

export interface GmailWatchState {
  historyId?:  string;
  expiration?: number; // ms epoch
}

export interface CalendarWatchState {
  channelId?:  string;
  resourceId?: string;
  syncToken?:  string;
  expiration?: number; // ms epoch
}

export interface WatchState {
  gmail?:    GmailWatchState;
  calendar?: CalendarWatchState;
}

export async function getWatchState(): Promise<WatchState> {
  return readStore<WatchState>(WATCH_FILE, {});
}

export async function updateGmail(patch: Partial<GmailWatchState>): Promise<void> {
  const s = await getWatchState();
  await writeStore<WatchState>(WATCH_FILE, {
    ...s,
    gmail: { ...s.gmail, ...patch },
  });
}

export async function updateCalendar(patch: Partial<CalendarWatchState>): Promise<void> {
  const s = await getWatchState();
  await writeStore<WatchState>(WATCH_FILE, {
    ...s,
    calendar: { ...s.calendar, ...patch },
  });
}
