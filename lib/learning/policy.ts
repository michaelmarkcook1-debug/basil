/**
 * lib/learning/policy.ts
 *
 * Turns raw interaction history into "suspend this source?" suggestions.
 *
 * Thresholds are deliberately conservative — the costly error is suppressing a
 * source that later matters, so we only suggest (never auto-mute), require a
 * real streak (not n=1), require ZERO opens in the window, and back off for a
 * cooldown after the user says "not now".
 */

import type { LearningStore, MuteSuggestion } from "./types";

export const WINDOW_DAYS = 21;
const MIN_DELETES = 4;          // need a real streak, not a one-off
const DELETE_RATE = 0.6;        // ≥60% of engagement with this source is deletion
const DISMISS_COOLDOWN_DAYS = 30;

/** Only sources we can actually suspend ingestion for in slice 1 (Slack groups). */
function isSuspendable(sourceKey: string): boolean {
  return sourceKey.startsWith("slack:");
}

export function computeMuteSuggestions(store: LearningStore): MuteSuggestion[] {
  const nowMs = Date.now();
  const windowStartMs = nowMs - WINDOW_DAYS * 86_400_000;
  const cooldownMs = DISMISS_COOLDOWN_DAYS * 86_400_000;

  const mutedOrDemoted = new Set((store.preferences ?? []).map((p) => p.sourceKey));
  const dismissedRecently = new Set(
    (store.dismissals ?? [])
      .filter((d) => nowMs - new Date(d.ts).getTime() < cooldownMs)
      .map((d) => d.sourceKey)
  );

  // Tally per source within the window.
  const tally = new Map<string, { deletes: number; opens: number; total: number }>();
  for (const e of store.events ?? []) {
    if (new Date(e.ts).getTime() < windowStartMs) continue;
    if (!isSuspendable(e.sourceKey)) continue;
    const t = tally.get(e.sourceKey) ?? { deletes: 0, opens: 0, total: 0 };
    t.total += 1;
    if (e.action === "delete") t.deletes += 1;
    if (e.action === "opened") t.opens += 1;
    tally.set(e.sourceKey, t);
  }

  const suggestions: MuteSuggestion[] = [];
  for (const [sourceKey, t] of tally) {
    if (mutedOrDemoted.has(sourceKey)) continue;
    if (dismissedRecently.has(sourceKey)) continue;
    if (t.opens > 0) continue;
    if (t.deletes < MIN_DELETES) continue;
    if (t.deletes / t.total < DELETE_RATE) continue;
    suggestions.push({
      sourceKey,
      sourceLabel: sourceKey, // resolved to a channel name by the API layer
      deletes: t.deletes,
      total: t.total,
      windowDays: WINDOW_DAYS,
    });
  }

  return suggestions.sort((a, b) => b.deletes - a.deletes);
}
