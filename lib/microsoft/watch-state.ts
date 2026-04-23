/**
 * Persists Microsoft Graph subscription state via the shared store so it
 * survives Vercel cold starts (included in the BASIL_DATA snapshot).
 *
 * Subscriptions are used to receive change notifications (webhooks) for
 * mail and calendar resources.  The deltaLink tracks incremental sync
 * position for each resource so we only process new changes.
 */

import { readStore, writeStore } from "@/lib/storage/persistent";

const WATCH_FILE = "microsoft-watch.json";

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

export async function getWatchState(): Promise<MicrosoftWatchState> {
  return readStore<MicrosoftWatchState>(WATCH_FILE, {});
}

export async function updateMail(patch: Partial<MicrosoftSubscription>): Promise<void> {
  const s = await getWatchState();
  await writeStore<MicrosoftWatchState>(WATCH_FILE, {
    ...s,
    mail: { ...s.mail, ...patch } as MicrosoftSubscription,
  });
}

export async function updateCalendar(patch: Partial<MicrosoftSubscription>): Promise<void> {
  const s = await getWatchState();
  await writeStore<MicrosoftWatchState>(WATCH_FILE, {
    ...s,
    calendar: { ...s.calendar, ...patch } as MicrosoftSubscription,
  });
}
