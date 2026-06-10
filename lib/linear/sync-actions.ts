/**
 * Reconciles Basil actions sourced from Linear with the live issue state.
 *
 * Linear issues become Basil actions via poll-ingest (`source: "linear"`,
 * `sourceRef: "linear:<identifier>"`). When the user closes / cancels /
 * reassigns the issue inside Linear, the action keeps showing in the
 * commitments list until something brings it into sync — that's this file.
 *
 * Rule: if a `linear:*` sourceRef on an open Basil action is NOT in the
 * current "my open issues" list returned by Linear, mark the action done.
 * That covers issue completed/canceled, and reassignment away from the user
 * (which should also drop it from their personal commitments).
 *
 * Cached per user with a short TTL so chat tools that hit `listActions` can
 * sync without spawning an extra GraphQL call on every keystroke.
 */

import { getMyOpenIssues, isLinearConnected } from "@/lib/linear/client";
import { listActions, updateAction } from "@/lib/actions/store";
import type { ActionItem } from "@/lib/types/action";

// ── In-memory rate limiter ────────────────────────────────────────────────────

/** Map<username, lastSyncedAt-ms>. */
const lastSyncedAt = new Map<string, number>();

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 min — fresh enough for chat use

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Pull Linear identifiers out of an action's sourceRef + additionalSourceRefs. */
function linearIdsFromAction(action: ActionItem): string[] {
  const refs: string[] = [];
  if (action.sourceRef) refs.push(action.sourceRef);
  if (action.additionalSourceRefs) refs.push(...action.additionalSourceRefs);
  return refs
    .filter((r) => r.startsWith("linear:"))
    .map((r) => r.slice("linear:".length).trim())
    .filter(Boolean);
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface SyncResult {
  /** Number of actions inspected. */
  inspected: number;
  /** Number marked done by this run. */
  closed: number;
  /** Skipped because of TTL — surface so callers can log telemetry. */
  cached?: boolean;
}

/**
 * Sync the user's linear-sourced actions against current Linear state.
 *
 * Pass `{ force: true }` to bypass the per-user TTL (e.g. from the webhook
 * receiver — push events should always reflect reality immediately).
 */
export async function syncLinearActionStates(
  username: string,
  options: { force?: boolean; ttlMs?: number } = {}
): Promise<SyncResult> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;

  if (!options.force) {
    const last = lastSyncedAt.get(username);
    if (last && Date.now() - last < ttlMs) {
      return { inspected: 0, closed: 0, cached: true };
    }
  }
  lastSyncedAt.set(username, Date.now());

  if (!(await isLinearConnected(username))) {
    return { inspected: 0, closed: 0 };
  }

  // 1. Snapshot of "my open issues" — identifiers we'll compare against.
  let openIdentifiers: Set<string>;
  try {
    const open = await getMyOpenIssues(username);
    openIdentifiers = new Set(open.map((i) => i.identifier));
  } catch (err) {
    console.warn(
      "[linear-sync] failed to fetch open issues; aborting sync:",
      err instanceof Error ? err.message : err
    );
    return { inspected: 0, closed: 0 };
  }

  // 2. Walk the user's open Basil actions — only consider those still open.
  let actions: ActionItem[];
  try {
    actions = await listActions(username);
  } catch (err) {
    console.warn("[linear-sync] failed to list actions:", err);
    return { inspected: 0, closed: 0 };
  }

  const candidates = actions.filter((a) => {
    if (a.status === "done") return false;
    if (a.source !== "linear") {
      // The action may have been cross-source-deduped — its source might be
      // email/slack now but it still carries a Linear sourceRef.
      const hasLinearRef = linearIdsFromAction(a).length > 0;
      if (!hasLinearRef) return false;
    }
    return true;
  });

  let closed = 0;

  for (const action of candidates) {
    const linearIds = linearIdsFromAction(action);
    if (linearIds.length === 0) continue;

    // If EVERY linear ref on this action is no longer "my open", close it.
    // (We're conservative — if any linked issue is still mine + open, keep it.)
    const allClosed = linearIds.every((id) => !openIdentifiers.has(id));
    if (!allClosed) continue;

    try {
      await updateAction(username, action.id, {
        status: "done",
        lastActivityAt: new Date().toISOString(),
      });
      closed++;
    } catch (err) {
      console.warn(
        `[linear-sync] failed to close action ${action.id}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  if (closed > 0) {
    console.log(
      `[linear-sync] closed ${closed} stale action(s) for ${username}`
    );
  }

  return { inspected: candidates.length, closed };
}
