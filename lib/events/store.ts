import { randomUUID } from "node:crypto";
import type { BasilEvent, EventStatus } from "./types";
import { withLock } from "./lock";
import { readStore, writeStore } from "@/lib/storage/persistent";

// sage-events.json is deliberately excluded from the BASIL_DATA snapshot
// (see lib/storage/persistent.ts EXCLUDED set) — events are ephemeral and
// can grow large. We use the persistent layer so the file resolves to
// /tmp/basil-data on Vercel (writable) rather than process.cwd()/.data
// (read-only on Fluid Compute).
const EVENTS_FILE = "sage-events.json";
const LOCK_KEY = "events";

// ── Internal read / write ────────────────────────────────────────────────────

async function readAll(): Promise<BasilEvent[]> {
  return readStore<BasilEvent[]>(EVENTS_FILE, []);
}

async function writeAll(events: BasilEvent[]): Promise<void> {
  await writeStore(EVENTS_FILE, events, undefined, { durability: "strong" });
}

// ── One-time legacy migration ─────────────────────────────────────────────────
//
// Before the persistent-layer migration, the event store wrote directly to
// `process.cwd()/.data/sage-events.json` using node:fs.  On local dev that
// path is identical to what the persistent layer resolves to — so no file
// migration is needed.  On Vercel the old path was read-only and nothing was
// ever written there.
//
// What DOES need normalisation: stored records that pre-date the `sourceRef`
// field will have `externalId` set but `sourceRef` absent.  We backfill once
// per process start so that `hasExternalId` works correctly for both old and
// new records.

let normalisedOnce = false;

async function normaliseLegacyFields(): Promise<void> {
  if (normalisedOnce) return;
  normalisedOnce = true;

  await withLock(LOCK_KEY, async () => {
    const all = await readStore<BasilEvent[]>(EVENTS_FILE, []);
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

    if (dirty) await writeStore(EVENTS_FILE, all, undefined, { durability: "strong" });
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function listEvents(): Promise<BasilEvent[]> {
  await normaliseLegacyFields();
  const all = await readAll();
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listPendingEvents(): Promise<BasilEvent[]> {
  const all = await listEvents();
  return all.filter((e) => e.status === "pending");
}

export async function listActiveEvents(): Promise<BasilEvent[]> {
  // Active = what Basil is "watching" — pending drafts + unacknowledged notifies
  const all = await listEvents();
  return all.filter(
    (e) =>
      e.status === "pending" ||
      (e.disposition === "notify" && e.status !== "acknowledged")
  );
}

export async function getEvent(id: string): Promise<BasilEvent | null> {
  await normaliseLegacyFields();
  const all = await readAll();
  return all.find((e) => e.id === id) ?? null;
}

export async function createEvent(
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

  return withLock(LOCK_KEY, async () => {
    const all = await readAll();
    all.push(unified);
    await writeAll(all);
    return unified;
  });
}

/**
 * Patch any subset of mutable fields on an event.
 * Automatically keeps sourceRef and externalId in sync if either is provided.
 */
export async function updateEvent(
  id: string,
  patch: Partial<Omit<BasilEvent, "id" | "createdAt">>
): Promise<BasilEvent | null> {
  return withLock(LOCK_KEY, async () => {
    const all = await readAll();
    const idx = all.findIndex((e) => e.id === id);
    if (idx === -1) return null;

    const merged = { ...all[idx], ...patch, updatedAt: new Date().toISOString() };

    // Keep the dual-field pair in sync
    if (patch.sourceRef && !patch.externalId) merged.externalId = patch.sourceRef;
    if (patch.externalId && !patch.sourceRef) merged.sourceRef = patch.externalId;

    all[idx] = merged;
    await writeAll(all);
    return all[idx];
  });
}

/** Convenience wrapper — kept for call-sites that only need to change status. */
export async function updateEventStatus(
  id: string,
  status: EventStatus
): Promise<BasilEvent | null> {
  return updateEvent(id, { status });
}

export async function deleteEvent(id: string): Promise<boolean> {
  return withLock(LOCK_KEY, async () => {
    const all = await readAll();
    const next = all.filter((e) => e.id !== id);
    if (next.length === all.length) return false;
    await writeAll(next);
    return true;
  });
}

/** Replace the entire store — used by the seeding endpoint. */
export async function replaceAll(events: BasilEvent[]): Promise<void> {
  return withLock(LOCK_KEY, async () => writeAll(events));
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
export async function compactEvents(): Promise<number> {
  return withLock(LOCK_KEY, async () => {
    const all    = await readStore<BasilEvent[]>(EVENTS_FILE, []);
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
      await writeStore(EVENTS_FILE, compacted, undefined, { durability: "strong" });
      console.log(`[events] Compacted ${pruned} stale event(s) (${before} → ${compacted.length} total)`);
    }
    return pruned;
  });
}

/**
 * Returns true if an event with this external reference already exists.
 * Checks both sourceRef (canonical) and externalId (legacy) to handle
 * records written by either the old or the new code path.
 */
export async function hasExternalId(ref: string): Promise<boolean> {
  await normaliseLegacyFields();
  const all = await readAll();
  return all.some((e) => e.sourceRef === ref || e.externalId === ref);
}
