import { randomUUID } from "node:crypto";
import type { BasilEvent, EventStatus } from "./types";
import { withLock } from "./lock";
import { readUserStore, writeUserStore } from "@/lib/storage/user-store";

// sage-events.json is deliberately excluded from the BASIL_DATA snapshot
// (see lib/storage/persistent.ts EXCLUDED set) — events are ephemeral and
// can grow large.  Events are now stored per-user under the user-store layer
// so they live at basil/users/<safeUsername>/sage-events.json in Blob.
const EVENTS_FILE = "sage-events.json";

// Per-user lock key — concurrent writes from different users don't block each other.
function lockKey(username: string) {
  return `events:${username}`;
}

// ── Internal read / write ────────────────────────────────────────────────────

/**
 * Read the events store.
 *
 * `fresh: true` bypasses the /tmp write-through cache and re-reads the durable
 * store. EVERY read inside a withLock() read-modify-write MUST pass it.
 *
 * The lock provides mutual exclusion, NOT freshness — those are different
 * guarantees, and conflating them cost real user data. Observed live
 * 2026-07-30: poll-ingest created 15 zoom_email events, yet the durable store
 * was written minutes later containing zero of them, its newest record over an
 * hour stale. A lock holder had read the stale /tmp snapshot, appended to that,
 * and written the whole array back — silently erasing every event created in
 * the interim. The same bug was fixed in lib/actions/store.ts earlier; the
 * events store was missed because it looked correct: it *does* hold the lock.
 */
async function readAll(username: string, options?: { fresh?: boolean }): Promise<BasilEvent[]> {
  return readUserStore<BasilEvent[]>(username, EVENTS_FILE, [], options);
}

async function writeAll(username: string, events: BasilEvent[]): Promise<void> {
  await writeUserStore(username, EVENTS_FILE, events);
}

// ── One-time legacy migration ─────────────────────────────────────────────────
//
// Before the user-scoping migration, events were stored in a global
// sage-events.json (no user prefix).  Records written before the sourceRef
// field existed need backfilling so hasExternalId works correctly.
//
// Normalisation is per-user and lazy: it runs once for each username per
// process lifetime the first time that user's events are accessed.

const normalisedByUser = new Set<string>();

async function normaliseLegacyFields(username: string): Promise<void> {
  if (normalisedByUser.has(username)) return;
  normalisedByUser.add(username);

  await withLock(lockKey(username), async () => {
    // fresh: true — this rewrites the ENTIRE array, so a stale read here
    // clobbers every event written since the cache was populated. It is also
    // the first thing hasExternalId() touches, so it runs on cold paths that
    // are otherwise read-only.
    const all = await readUserStore<BasilEvent[]>(username, EVENTS_FILE, [], { fresh: true });
    let dirty = false;

    for (const e of all) {
      // Backfill sourceRef from externalId
      if (e.externalId && !e.sourceRef) {
        e.sourceRef = e.externalId;
        dirty = true;
      }
      // Backfill externalId from sourceRef (handles the reverse case)
      if (e.sourceRef && !e.externalId) {
        e.externalId = e.sourceRef;
        dirty = true;
      }
      // Ensure tags is always an array (very old records may have omitted it)
      if (!Array.isArray(e.tags)) {
        (e as BasilEvent).tags = [];
        dirty = true;
      }
    }

    if (dirty) await writeUserStore(username, EVENTS_FILE, all);
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function listEvents(username: string): Promise<BasilEvent[]> {
  await normaliseLegacyFields(username);
  const all = await readAll(username);
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listPendingEvents(username: string): Promise<BasilEvent[]> {
  const all = await listEvents(username);
  return all.filter((e) => e.status === "pending");
}

export async function listActiveEvents(username: string): Promise<BasilEvent[]> {
  // Active = what Basil is "watching" — pending drafts + unacknowledged notifies
  const all = await listEvents(username);
  return all.filter(
    (e) =>
      e.status === "pending" ||
      (e.disposition === "notify" && e.status !== "acknowledged")
  );
}

export async function getEvent(username: string, id: string): Promise<BasilEvent | null> {
  await normaliseLegacyFields(username);
  const all = await readAll(username);
  return all.find((e) => e.id === id) ?? null;
}

export async function createEvent(
  username: string,
  e: Omit<BasilEvent, "id" | "createdAt" | "updatedAt">
): Promise<BasilEvent> {
  // Ensure both sourceRef and externalId are in sync on creation
  const now = new Date().toISOString();
  const unified: BasilEvent = {
    ...e,
    sourceRef: e.sourceRef ?? e.externalId,
    externalId: e.externalId ?? e.sourceRef,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
  };

  return withLock(lockKey(username), async () => {
    const all = await readAll(username, { fresh: true });
    all.push(unified);
    await writeAll(username, all);
    return unified;
  });
}

/**
 * Patch any subset of mutable fields on an event.
 * Automatically keeps sourceRef and externalId in sync if either is provided.
 */
export async function updateEvent(
  username: string,
  id: string,
  patch: Partial<Omit<BasilEvent, "id" | "createdAt">>
): Promise<BasilEvent | null> {
  return withLock(lockKey(username), async () => {
    const all = await readAll(username, { fresh: true });
    const idx = all.findIndex((e) => e.id === id);
    if (idx === -1) return null;

    const merged = { ...all[idx], ...patch, updatedAt: new Date().toISOString() };

    // Keep the dual-field pair in sync
    if (patch.sourceRef && !patch.externalId) merged.externalId = patch.sourceRef;
    if (patch.externalId && !patch.sourceRef) merged.sourceRef = patch.externalId;

    all[idx] = merged;
    await writeAll(username, all);
    return all[idx];
  });
}

/** Convenience wrapper — kept for call-sites that only need to change status. */
export async function updateEventStatus(
  username: string,
  id: string,
  status: EventStatus
): Promise<BasilEvent | null> {
  return updateEvent(username, id, { status });
}

export async function deleteEvent(username: string, id: string): Promise<boolean> {
  return withLock(lockKey(username), async () => {
    const all = await readAll(username, { fresh: true });
    const next = all.filter((e) => e.id !== id);
    if (next.length === all.length) return false;
    await writeAll(username, next);
    return true;
  });
}

/** Replace the entire store — used by the seeding endpoint. */
export async function replaceAll(username: string, events: BasilEvent[]): Promise<void> {
  return withLock(lockKey(username), async () => writeAll(username, events));
}

// ── Event retention / compaction ─────────────────────────────────────────────
//
// Retention rules (applied in order):
//   KEEP — status is "pending", "executing", or "approved" (legacy)
//   KEEP — disposition is "notify" AND not yet acknowledged
//   KEEP — created within the last PRUNE_AGE_MS milliseconds
//   PRUNE — everything else (acknowledged, executed, rejected, failed; older than 7 days)
//
// After age-based pruning, a hard cap (MAX_EVENTS) evicts the oldest
// non-pending events if the store is still too large.
//
// Provenance note: no action / decision / memory records are deleted here.
// Those are stored in separate files and retain their eventId/sourceRef links.
// Compaction only removes the ephemeral event receipt record, not the derived data.

const PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_EVENTS   = 300;

/**
 * Prune stale events from the store and return the number removed.
 *
 * Safe to call at any time — never removes operationally pending events.
 * Idempotent: calling it repeatedly is harmless.
 */
export async function compactEvents(username: string): Promise<number> {
  return withLock(lockKey(username), async () => {
    const all    = await readAll(username, { fresh: true });
    const before = all.length;
    const cutoff = Date.now() - PRUNE_AGE_MS;

    // Age-based pruning
    const afterAging = all.filter((e) => {
      // Always keep operationally pending / in-flight events
      if (e.status === "pending" || e.status === "executing" || e.status === "approved") {
        return true;
      }
      // Always keep unacknowledged notify events regardless of age
      if (e.disposition === "notify" && e.status !== "acknowledged") {
        return true;
      }
      // Keep recent events regardless of status
      if (new Date(e.createdAt).getTime() > cutoff) {
        return true;
      }
      // Prune old acknowledged / resolved events
      return false;
    });

    // Hard cap: keep only the most recent MAX_EVENTS non-pending events
    // if the store is still too large after age-based pruning.
    let compacted = afterAging;
    if (compacted.length > MAX_EVENTS) {
      const mustKeep = compacted.filter(
        (e) => e.status === "pending" || e.status === "executing" || e.status === "approved"
      );
      const evictable = compacted
        .filter((e) => e.status !== "pending" && e.status !== "executing" && e.status !== "approved")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)) // newest first
        .slice(0, MAX_EVENTS - mustKeep.length);
      compacted = [...mustKeep, ...evictable];
    }

    const pruned = before - compacted.length;
    if (pruned > 0) {
      await writeAll(username, compacted);
      console.log(`[events:${username}] Compacted ${pruned} stale event(s) (${before} → ${compacted.length} total)`);
    }
    return pruned;
  });
}

/**
 * Returns true if an event with this external reference already exists for
 * the given user.  Checks both sourceRef (canonical) and externalId (legacy)
 * to handle records written by either the old or the new code path.
 */
export async function hasExternalId(username: string, ref: string): Promise<boolean> {
  await normaliseLegacyFields(username);
  const all = await readAll(username);
  return all.some((e) => e.sourceRef === ref || e.externalId === ref);
}
