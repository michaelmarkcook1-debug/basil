/**
 * Persists Microsoft Graph subscription state per user via the shared store so
 * it survives Vercel cold starts.
 *
 * All functions require a username so each user's watch state is kept under
 * users/<safe>/microsoft-watch.json — preventing cross-user state leakage.
 */

import { readStore, writeStore } from "@/lib/storage/persistent";

const WATCH_FILE = "microsoft-watch.json";

/** Convert a username to a filesystem-safe directory component. */
function safeUser(username: string): string {
  return username.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function subdir(username: string): string {
  return `users/${safeUser(username)}`;
}

export interface MicrosoftSubscription {
  subscriptionId:      string;
  expirationDateTime:  string; // ISO
  resource:            string;
  clientState:         string; // secret to verify notifications
  deltaLink?:          string; // for incremental mail/calendar delta queries
}

export interface MicrosoftWatchState {
  mail?:     MicrosoftSubscription;
  calendar?: MicrosoftSubscription;
}

export async function getWatchState(username: string): Promise<MicrosoftWatchState> {
  return readStore<MicrosoftWatchState>(WATCH_FILE, {}, subdir(username));
}

export async function updateMail(username: string, patch: Partial<MicrosoftSubscription>): Promise<void> {
  const s = await getWatchState(username);
  await writeStore<MicrosoftWatchState>(WATCH_FILE, {
    ...s,
    mail: { ...s.mail, ...patch } as MicrosoftSubscription,
  }, subdir(username), { durability: "strong" });
}

export async function updateCalendar(username: string, patch: Partial<MicrosoftSubscription>): Promise<void> {
  const s = await getWatchState(username);
  await writeStore<MicrosoftWatchState>(WATCH_FILE, {
    ...s,
    calendar: { ...s.calendar, ...patch } as MicrosoftSubscription,
  }, subdir(username), { durability: "strong" });
}
