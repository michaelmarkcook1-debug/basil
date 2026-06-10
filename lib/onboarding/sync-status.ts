/**
 * lib/onboarding/sync-status.ts — track a user's first-sync (backfill) window.
 *
 * When a day-0 backfill is kicked off (lib/onboarding/backfill.ts), we stamp a
 * marker. The dashboard reads it to show a "first sync in progress" banner
 * instead of bare empty states to someone who just connected their accounts.
 *
 * server-only.
 */

import "server-only";
import { readUserStore, writeUserStore } from "@/lib/storage/user-store";

const FILE = "onboarding-sync.json";

/** How long after a backfill starts we still call it "syncing" (ms). */
const SYNC_WINDOW_MS = 3 * 60 * 1000;

interface SyncMarker {
  startedAt: string; // ISO
}

/** Stamp the start of a backfill. Best-effort — never throws. */
export async function markSyncStarted(username: string): Promise<void> {
  try {
    await writeUserStore<SyncMarker>(username, FILE, { startedAt: new Date().toISOString() });
  } catch (err) {
    console.warn(`[sync-status] markSyncStarted failed for ${username}:`, err instanceof Error ? err.message : err);
  }
}

/** True when a backfill started within the sync window. */
export async function isSyncing(username: string): Promise<boolean> {
  try {
    const marker = await readUserStore<SyncMarker | null>(username, FILE, null);
    if (!marker?.startedAt) return false;
    const started = Date.parse(marker.startedAt);
    return Number.isFinite(started) && Date.now() - started < SYNC_WINDOW_MS;
  } catch {
    return false;
  }
}
