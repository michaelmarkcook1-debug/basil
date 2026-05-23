/**
 * Signal Thread Store
 *
 * Persists and retrieves SignalThread records per user.
 * Gated on signalThread_active feature flag in all callers.
 *
 * Storage: "sage-signal-threads.json" — Record<threadId, SignalThread>
 * FIFO cap: 500 threads per user (keeps the most recently active)
 *
 * Thread upsert strategy:
 *   1. Look up by threadKey (source's stable thread identifier)
 *   2. If found: addSignalToThread() → write back
 *   3. If not found: buildSignalThread() → write
 *
 * Guardrails:
 *   - Never throws — errors are logged and swallowed
 *   - Idempotent writes (addSignalToThread deduplicates signalIds)
 */

import { readUserStore, writeUserStore } from "@/lib/storage/user-store";
import { hashContent } from "@/lib/ingest/content-hash";
import {
  buildSignalThread,
  addSignalToThread,
} from "@/core/primitives/signal-thread";
import type { SignalThread, SignalThreadStatus } from "@/core/primitives/signal-thread";
import type { SignalEvent } from "@/core/primitives/signal-event";

const THREAD_FILE = "sage-signal-threads.json";
const MAX_THREADS = 500;

// ── Storage shape ─────────────────────────────────────────────────────────────

type ThreadMap = Record<string, SignalThread>;

async function readThreadMap(username: string): Promise<ThreadMap> {
  return readUserStore<ThreadMap>(username, THREAD_FILE, {});
}

// ── Thread ID derivation ──────────────────────────────────────────────────────

/**
 * Derive a stable thread ID from source + threadKey.
 * Consistent with SignalEvent's hashContent-based ID scheme.
 */
export function deriveThreadId(
  source: string,
  threadKey: string
): string {
  return hashContent("thread", source, threadKey);
}

// ── Upsert ────────────────────────────────────────────────────────────────────

/**
 * Upsert a thread for a given signal.
 *
 * If the signal has a threadId (Slack messageTs, Gmail threadId), that is
 * the thread key. Otherwise the signal's own id is used (singleton thread).
 *
 * Returns the updated or created thread, or null on error.
 */
export async function upsertThread(
  username: string,
  signal: SignalEvent
): Promise<SignalThread | null> {
  try {
    const threadKey = signal.threadId ?? signal.id;
    const threadId = deriveThreadId(signal.source, threadKey);

    const map = await readThreadMap(username);
    const existing = map[threadId];

    let thread: SignalThread;

    if (existing) {
      thread = addSignalToThread(existing, {
        id: signal.id,
        occurredAt: signal.occurredAt,
        source: signal.source,
        category: signal.category,
        trustTier: signal.trust.trustTier,
        rawParticipants: signal.participants.map((p) => p.rawEmail ?? p.rawName),
        actionIds: signal.actionIds,
        decisionIds: signal.decisionIds,
        projects: signal.projects,
      });
    } else {
      thread = buildSignalThread({
        id: threadId,
        threadKey,
        primarySource: signal.source,
        title: signal.title,
        category: signal.category,
        trustTier: signal.trust.trustTier,
        firstSignalId: signal.id,
        firstSignalAt: signal.occurredAt,
        rawParticipants: signal.participants.map((p) => p.rawEmail ?? p.rawName),
        actionIds: signal.actionIds,
        decisionIds: signal.decisionIds,
        projects: signal.projects,
      });
    }

    // FIFO cap: if over limit, evict the stalest threads
    const allThreads = { ...map, [threadId]: thread };
    const entries = Object.entries(allThreads);
    if (entries.length > MAX_THREADS) {
      // Sort by lastSignalAt ascending (oldest first), keep newest MAX_THREADS
      const evicted = entries
        .sort(([, a], [, b]) => a.lastSignalAt.localeCompare(b.lastSignalAt))
        .slice(entries.length - MAX_THREADS);
      const trimmed: ThreadMap = Object.fromEntries(evicted);
      await writeUserStore(username, THREAD_FILE, trimmed);
      return trimmed[threadId] ?? thread;
    }

    await writeUserStore(username, THREAD_FILE, allThreads);
    return thread;
  } catch (err) {
    console.error(
      `[signal-thread-store] upsertThread failed for signal ${signal.id}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

// ── Read ──────────────────────────────────────────────────────────────────────

export interface ThreadQuery {
  status?: SignalThreadStatus;
  source?: string;
  limit?: number;
}

/**
 * Read signal threads, most-recently-active first.
 */
export async function readThreads(
  username: string,
  query: ThreadQuery = {}
): Promise<SignalThread[]> {
  try {
    const map = await readThreadMap(username);
    let threads = Object.values(map);

    if (query.status) {
      threads = threads.filter((t) => t.status === query.status);
    }
    if (query.source) {
      threads = threads.filter((t) => t.primarySource === query.source);
    }

    threads.sort((a, b) => b.lastSignalAt.localeCompare(a.lastSignalAt));
    return threads.slice(0, query.limit ?? 100);
  } catch {
    return [];
  }
}

/**
 * Read a single thread by its stable threadKey and source.
 */
export async function readThread(
  username: string,
  source: string,
  threadKey: string
): Promise<SignalThread | null> {
  try {
    const map = await readThreadMap(username);
    return map[deriveThreadId(source, threadKey)] ?? null;
  } catch {
    return null;
  }
}
