/**
 * Delta baseline store — persists the "last seen" timestamp per user.
 *
 * Lightweight: just one JSON record with a timestamp.
 * Updated when the user explicitly marks all changes as seen.
 */

import { readUserStore, writeUserStore } from "@/lib/storage/user-store";
import type { DeltaBaseline } from "./types";

const BASELINE_FILE = "sage-delta-baseline.json";

/** Default lookback window when no baseline exists: 24 hours. */
const DEFAULT_LOOKBACK_HOURS = 24;

export async function readBaseline(username: string): Promise<DeltaBaseline> {
  const stored = await readUserStore<DeltaBaseline | null>(
    username,
    BASELINE_FILE,
    null
  );

  if (stored) return stored;

  // First visit — baseline defaults to 24h ago
  const fallback = new Date(
    Date.now() - DEFAULT_LOOKBACK_HOURS * 60 * 60 * 1000
  ).toISOString();

  return {
    lastSeenAt: fallback,
    createdAt: new Date().toISOString(),
  };
}

export async function markAllSeen(username: string): Promise<DeltaBaseline> {
  const now = new Date().toISOString();
  const baseline: DeltaBaseline = {
    lastSeenAt: now,
    createdAt: now,
  };
  await writeUserStore(username, BASELINE_FILE, baseline);
  return baseline;
}

/**
 * Returns the since-date for change computation:
 * - Uses the stored lastSeenAt if available
 * - Falls back to 24h ago
 * - Caps at 7 days to avoid surfacing ancient history
 */
export async function getSinceDate(username: string): Promise<Date> {
  const baseline = await readBaseline(username);
  const stored = new Date(baseline.lastSeenAt);
  const maxLookback = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // Return whichever is more recent: stored baseline or max lookback cap
  return stored > maxLookback ? stored : maxLookback;
}
