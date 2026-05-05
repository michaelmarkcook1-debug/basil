/**
 * Ingest index — per-user, append-only lookup table for idempotency.
 *
 * Maps sourceRef → { hash, firstSeenAt, lastSeenAt, actionIds, decisionIds, memoryIds }
 *
 * Used during materialization to:
 *   1. Skip the AI extraction call if hash hasn't changed (same content).
 *   2. Determine whether to create or update extracted items.
 *   3. Associate source messages with the items they produced.
 *
 * The index file is treated as a pure lookup cache — safe to delete and rebuild
 * from the canonical item stores if needed.
 */
import { readUserStore, writeUserStore } from "@/lib/storage/user-store";
import { withLock } from "@/lib/events/lock";

export const INGEST_INDEX_FILE = "sage-ingest-index.json";

export interface IngestEntry {
  /** 16-char hex hash from hashContent() — covers the key source fields. */
  hash: string;
  /** ISO timestamp of first ingestion. */
  firstSeenAt: string;
  /** ISO timestamp of most recent ingestion attempt. */
  lastSeenAt: string;
  /** IDs of Action items created/updated from this source message. */
  actionIds: string[];
  /** IDs of Decision items created/updated from this source message. */
  decisionIds: string[];
  /** IDs of Memory items created/updated from this source message. */
  memoryIds: string[];
  /** IDs of Contact items created/updated from this source message. */
  contactIds: string[];
}

/** The full index is a plain map from sourceRef → IngestEntry. */
export type IngestIndex = Record<string, IngestEntry>;

function lockKey(username: string): string {
  return `ingest-index:${username}`;
}

async function readAll(username: string): Promise<IngestIndex> {
  return readUserStore<IngestIndex>(username, INGEST_INDEX_FILE, {});
}

// ── Public read API ────────────────────────────────────────────────────────────

/**
 * Look up a single source reference.
 * Returns undefined if the source has never been ingested.
 */
export async function getIngestEntry(
  username: string,
  sourceRef: string
): Promise<IngestEntry | undefined> {
  const index = await readAll(username);
  return index[sourceRef];
}

/**
 * Check whether the given sourceRef has been ingested with this exact hash.
 * Returns true → same content, skip AI call.
 * Returns false → new or changed content, proceed with extraction.
 */
export async function isHashUnchanged(
  username: string,
  sourceRef: string,
  hash: string
): Promise<boolean> {
  const entry = await getIngestEntry(username, sourceRef);
  return entry !== undefined && entry.hash === hash;
}

// ── Public write API ───────────────────────────────────────────────────────────

export interface RecordIngestOptions {
  sourceRef: string;
  hash: string;
  actionIds?: string[];
  decisionIds?: string[];
  memoryIds?: string[];
  contactIds?: string[];
}

/**
 * Upsert an ingest index entry after a successful materialization.
 * Merges new item IDs with any previously recorded for this sourceRef.
 * Fire-and-forget safe — errors are caught and logged.
 */
export async function recordIngest(
  username: string,
  opts: RecordIngestOptions
): Promise<void> {
  const { sourceRef, hash, actionIds = [], decisionIds = [], memoryIds = [], contactIds = [] } =
    opts;
  try {
    await withLock(lockKey(username), async () => {
      const index = await readAll(username);
      const existing = index[sourceRef];
      const now = new Date().toISOString();

      const merged = unique([
        ...(existing?.actionIds ?? []),
        ...actionIds,
      ]);
      const mergedDecisions = unique([
        ...(existing?.decisionIds ?? []),
        ...decisionIds,
      ]);
      const mergedMemories = unique([
        ...(existing?.memoryIds ?? []),
        ...memoryIds,
      ]);
      const mergedContacts = unique([
        ...(existing?.contactIds ?? []),
        ...contactIds,
      ]);

      index[sourceRef] = {
        hash,
        firstSeenAt: existing?.firstSeenAt ?? now,
        lastSeenAt: now,
        actionIds: merged,
        decisionIds: mergedDecisions,
        memoryIds: mergedMemories,
        contactIds: mergedContacts,
      };

      await writeUserStore(username, INGEST_INDEX_FILE, index);
    });
  } catch (err) {
    console.error(
      "[ingest-index] write failed:",
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Remove a source reference from the index (e.g. when a source item is deleted).
 * Fire-and-forget safe.
 */
export async function removeIngestEntry(
  username: string,
  sourceRef: string
): Promise<void> {
  try {
    await withLock(lockKey(username), async () => {
      const index = await readAll(username);
      if (sourceRef in index) {
        delete index[sourceRef];
        await writeUserStore(username, INGEST_INDEX_FILE, index);
      }
    });
  } catch (err) {
    console.error(
      "[ingest-index] remove failed:",
      err instanceof Error ? err.message : err
    );
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function unique(arr: string[]): string[] {
  return [...new Set(arr)];
}
