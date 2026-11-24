/**
 * lib/workstreams/sort-actions.ts — file every open commitment into a
 * workstream, not just the ones Today happens to show.
 *
 * Michael, 2026-11-24: "commitments aren't autocategorising and they don't
 * show consistently across the app". The classifier only ran inside Today's
 * background rebuild (≤50 per pass), and /api/actions only overlays existing
 * verdicts — so a new commitment stayed "Unsorted" until Today rebuilt with it,
 * and a workstream filter (shared by Today and Actions) hid it everywhere.
 *
 * Now open actions without a verdict are sorted:
 *   - in the background after any read of /api/actions (at most every 10 min);
 *   - at the end of the daily re-classification run (cron, 06:00 UTC).
 * Rules and the user's own filings first (free), then the fast-tier
 * classifier for the rest, capped per run.
 */
import "server-only";
import { listActions } from "@/lib/actions/store";
import { readWorkstreams } from "@/lib/workstreams/store";
import { assignWorkstreams } from "@/lib/workstreams/classify";
import { actionKey, actionSubject } from "@/lib/workstreams/attach";

const MIN_GAP_MS = 10 * 60 * 1000;
const lastRun = new Map<string, number>();

export async function sortOpenActions(username: string, opts: { limit?: number; force?: boolean } = {}): Promise<{ checked: number; filed: number; skipped?: string }> {
  if (!opts.force && Date.now() - (lastRun.get(username) ?? 0) < MIN_GAP_MS) return { checked: 0, filed: 0, skipped: "ran recently" };
  lastRun.set(username, Date.now());
  const [actions, store] = await Promise.all([listActions(username), readWorkstreams(username)]);
  const unsorted = actions.filter((a) => a.status !== "done" && !store.verdicts[actionKey(a.id)]);
  if (unsorted.length === 0) return { checked: 0, filed: 0 };
  const placed = await assignWorkstreams(username, unsorted.map(actionSubject), { aiLimit: opts.limit ?? 60, store });
  const filed = [...placed.values()].filter((p) => p.workstream).length;
  console.log(`[workstreams] ${username}: sorted ${filed} of ${unsorted.length} unsorted open commitments`);
  return { checked: unsorted.length, filed };
}
