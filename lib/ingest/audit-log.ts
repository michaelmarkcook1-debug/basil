/**
 * Ingest audit log — per-user, append-only, circular buffer.
 *
 * Every materialization outcome is recorded here:
 *   "created"           — a new action/decision/memory was written
 *   "updated"           — an existing item was updated (hash changed)
 *   "skipped_duplicate" — sourceRef + hash matched; AI call was skipped
 *   "failed"            — extraction or store write threw an error
 *
 * Used by the system health panel to show recent ingest activity and surface
 * any failures that need attention.
 *
 * Storage: sage-ingest-audit.json per user (max MAX_ENTRIES = 2000 entries).
 */
import { randomUUID } from "node:crypto";
import { readUserStore, writeUserStore } from "@/lib/storage/user-store";
import { withLock } from "@/lib/events/lock";

export const AUDIT_FILE = "sage-ingest-audit.json";
const MAX_ENTRIES = 2_000;

export type AuditAction =
  | "created"
  | "updated"
  | "skipped_duplicate"
  | "failed";

export type AuditItemType =
  | "action"
  | "decision"
  | "memory"
  | "contact"
  | "event";

export interface AuditEntry {
  /** Short unique ID for this audit entry. */
  id: string;
  /** ISO timestamp. */
  ts: string;
  /** Source reference: "gmail:XXX", "slack:ch:ts", "zoom-api:XXX", etc. */
  sourceRef: string;
  /** What happened during this ingest attempt. */
  action: AuditAction;
  /** The kind of item this entry describes. */
  itemType: AuditItemType;
  /** ID of the created/updated item in the canonical store (e.g. "act-abc"). */
  itemId?: string;
  /** Short human-readable description of the outcome. */
  summary?: string;
  /** Error message if action === "failed". */
  error?: string;
}

function lockKey(username: string): string {
  return `ingest-audit:${username}`;
}

async function readAll(username: string): Promise<AuditEntry[]> {
  return readUserStore<AuditEntry[]>(username, AUDIT_FILE, []);
}

/**
 * Append one or more audit entries for a user.
 * Entries are prepended (newest first) and trimmed to MAX_ENTRIES.
 * Fire-and-forget safe — errors are caught and logged, never re-thrown.
 */
export async function appendAuditEntries(
  username: string,
  entries: AuditEntry[]
): Promise<void> {
  if (entries.length === 0) return;
  try {
    await withLock(lockKey(username), async () => {
      const existing = await readAll(username);
      const combined = [...entries, ...existing].slice(0, MAX_ENTRIES);
      await writeUserStore(username, AUDIT_FILE, combined);
    });
  } catch (err) {
    // Non-fatal — audit writes never block the critical path
    console.error(
      "[ingest-audit] write failed:",
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Read audit entries for a user, newest first.
 * @param limit Max entries to return (default 500).
 */
export async function readAuditLog(
  username: string,
  limit = 500
): Promise<AuditEntry[]> {
  const all = await readAll(username);
  return all.slice(0, limit);
}

// ── Factory helpers ────────────────────────────────────────────────────────────

export function auditCreated(
  sourceRef: string,
  itemType: AuditItemType,
  itemId: string,
  summary?: string
): AuditEntry {
  return {
    id: randomUUID().slice(0, 8),
    ts: new Date().toISOString(),
    sourceRef,
    action: "created",
    itemType,
    itemId,
    summary,
  };
}

export function auditUpdated(
  sourceRef: string,
  itemType: AuditItemType,
  itemId: string,
  summary?: string
): AuditEntry {
  return {
    id: randomUUID().slice(0, 8),
    ts: new Date().toISOString(),
    sourceRef,
    action: "updated",
    itemType,
    itemId,
    summary,
  };
}

export function auditSkipped(
  sourceRef: string,
  itemType: AuditItemType,
  summary?: string
): AuditEntry {
  return {
    id: randomUUID().slice(0, 8),
    ts: new Date().toISOString(),
    sourceRef,
    action: "skipped_duplicate",
    itemType,
    summary,
  };
}

export function auditFailed(
  sourceRef: string,
  itemType: AuditItemType,
  error: string,
  summary?: string
): AuditEntry {
  return {
    id: randomUUID().slice(0, 8),
    ts: new Date().toISOString(),
    sourceRef,
    action: "failed",
    itemType,
    error,
    summary,
  };
}
