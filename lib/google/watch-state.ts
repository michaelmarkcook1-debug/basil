/**
 * Persists Gmail + Calendar watch-channel state per user via the shared store
 * so it survives Vercel cold starts.
 *
 * All functions require a username so each user's watch state is kept under
 * users/<safe>/google-watch.json — preventing cross-user state leakage.
 */

import { readStore, writeStore } from "@/lib/storage/persistent";

const WATCH_FILE = "google-watch.json";

/** Convert a username to a filesystem-safe directory component. */
function safeUser(username: string): string {
  return username.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function subdir(username: string): string {
  return `users/${safeUser(username)}`;
}

export interface GmailWatchState {
  historyId?:   string;
  expiration?:  number; // ms epoch
  /** The Gmail address being watched — used to resolve webhook → username. */
  watchedEmail?: string;
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

export async function getWatchState(username: string): Promise<WatchState> {
  return readStore<WatchState>(WATCH_FILE, {}, subdir(username));
}

export async function updateGmail(username: string, patch: Partial<GmailWatchState>): Promise<void> {
  const s = await getWatchState(username);
  await writeStore<WatchState>(WATCH_FILE, {
    ...s,
    gmail: { ...s.gmail, ...patch },
  }, subdir(username), { durability: "strong" });
}

export async function updateCalendar(username: string, patch: Partial<CalendarWatchState>): Promise<void> {
  const s = await getWatchState(username);
  await writeStore<WatchState>(WATCH_FILE, {
    ...s,
    calendar: { ...s.calendar, ...patch },
  }, subdir(username), { durability: "strong" });
}
