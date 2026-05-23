/**
 * Signal Event Store
 *
 * Durable, per-user storage for canonical SignalEvents.
 * Written alongside the old pipeline when signalEvent_active is true.
 *
 * Design:
 *   - Keyed by SignalEvent.id (sha256-derived) — idempotent writes
 *   - FIFO cap: keeps the latest MAX_EVENTS entries to prevent unbounded growth
 *   - Stored in Blob as "sage-signal-events.json" (same tier as all other stores)
 *   - Read path supports filtering by source, eventType, date range, and limit
 *
 * This store is the canonical source of truth once the Gmail cutover
 * (sources.gmail_cutover) passes parity gates.
 *
 * Guardrails:
 *   - Never called from the old pipeline directly
 *   - All writes are gated on signalEvent_active feature flag in the caller
 *   - Never throws — errors are logged and swallowed to protect old pipeline
 */

import { readUserStore, writeUserStore } from "@/lib/storage/user-store";
import type { SignalEvent, SignalSource, SignalEventType } from "@/core/primitives/signal-event";

const SIGNAL_EVENTS_FILE = "sage-signal-events.json";
const MAX_EVENTS = 2_000;   // FIFO cap — keeps last 2000 signals per user

// ── Query options ─────────────────────────────────────────────────────────────

export interface SignalEventQuery {
  /** Filter by source system (e.g. "gmail", "slack"). */
  source?: SignalSource;
  /** Filter by event type. */
  eventType?: SignalEventType;
  /** Only include events on or after this date (ISO8601). */
  fromDate?: string;
  /** Only include events on or before this date (ISO8601). */
  toDate?: string;
  /** Max results to return (default 100, max 500). Applied after filtering. */
  limit?: number;
}

// ── Write ─────────────────────────────────────────────────────────────────────

/**
 * Write a SignalEvent to the store.
 * Idempotent: if an event with the same id already exists, it is replaced.
 * Applies FIFO cap after write.
 *
 * @returns The written event on success, or null on error.
 */
export async function writeSignalEvent(
  username: string,
  event: SignalEvent
): Promise<SignalEvent | null> {
  try {
    const existing = await readUserStore<SignalEvent[]>(username, SIGNAL_EVENTS_FILE, []);

    // Dedup by id — replace if exists, otherwise append
    const deduped = existing.filter((e) => e.id !== event.id);
    const updated = [...deduped, event].slice(-MAX_EVENTS);

    await writeUserStore(username, SIGNAL_EVENTS_FILE, updated);
    return event;
  } catch (err) {
    console.error(
      `[signal-event-store] write failed for ${event.sourceRef}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

// ── Read ──────────────────────────────────────────────────────────────────────

/**
 * Read signal events for a user, with optional filtering.
 * Returns most-recent first.
 */
export async function readSignalEvents(
  username: string,
  query: SignalEventQuery = {}
): Promise<SignalEvent[]> {
  const { source, eventType, fromDate, toDate, limit = 100 } = query;
  const cap = Math.min(limit, 500);

  const all = await readUserStore<SignalEvent[]>(username, SIGNAL_EVENTS_FILE, []);

  let filtered = all;

  if (source) {
    filtered = filtered.filter((e) => e.source === source);
  }
  if (eventType) {
    filtered = filtered.filter((e) => e.eventType === eventType);
  }
  if (fromDate) {
    filtered = filtered.filter((e) => e.occurredAt >= fromDate);
  }
  if (toDate) {
    filtered = filtered.filter((e) => e.occurredAt <= toDate);
  }

  // Most-recent first, capped
  return filtered.reverse().slice(0, cap);
}

/**
 * Read a single SignalEvent by id.
 */
export async function readSignalEvent(
  username: string,
  id: string
): Promise<SignalEvent | null> {
  const all = await readUserStore<SignalEvent[]>(username, SIGNAL_EVENTS_FILE, []);
  return all.find((e) => e.id === id) ?? null;
}

/**
 * Count signal events, optionally filtered by source.
 * Used by parity validator and admin dashboards.
 */
export async function countSignalEvents(
  username: string,
  source?: SignalSource
): Promise<number> {
  const all = await readUserStore<SignalEvent[]>(username, SIGNAL_EVENTS_FILE, []);
  if (!source) return all.length;
  return all.filter((e) => e.source === source).length;
}
