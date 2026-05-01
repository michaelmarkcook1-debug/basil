/**
 * Action store — persistent CRUD with per-user data isolation.
 *
 * All functions require a `username` argument.  Data is stored under
 * DATA_DIR/users/<username>/sage-actions.json so each user's actions
 * are completely isolated from other users.
 *
 * Dedup strategy:
 *   - Jaccard-similarity deduplication (two-layer: same-source idempotency +
 *     cross-source merge within 7 days)
 *   - Stale-action detection (open + no activity in 14 days + no due date)
 *   - Rich provenance tracking via sourceRef / additionalSourceRefs
 */

import { randomUUID } from "node:crypto";
import type { ActionItem, ActionPriority } from "@/lib/types/action";
import { withLock } from "@/lib/events/lock";
import { readUserStore, writeUserStore } from "@/lib/storage/user-store";
export { isActionStalled, STALE_THRESHOLD_DAYS } from "./utils";

const ACTIONS_FILE = "sage-actions.json";

function lockKey(username: string): string {
  return `actions:${username}`;
}

async function readAll(username: string): Promise<ActionItem[]> {
  return readUserStore<ActionItem[]>(username, ACTIONS_FILE, []);
}

async function writeAll(username: string, items: ActionItem[]): Promise<void> {
  await writeUserStore(username, ACTIONS_FILE, items);
}

function today(): string {
  return new Date().toISOString().split("T")[0];
}

// ── Dedup helpers ──────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "a", "an", "the", "to", "and", "or", "but", "in", "on", "at", "for",
  "with", "about", "as", "by", "from", "into", "of", "that", "this",
  "is", "are", "was", "were", "be", "been", "have", "has", "had",
  "will", "would", "could", "should", "do", "does", "did", "it",
  "i", "me", "my", "you", "your", "we", "our", "they", "their",
  "up", "out", "off", "re",
]);

function wordTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
  );
}

function jaccardSimilarity(a: string, b: string): number {
  const ta = wordTokens(a);
  const tb = wordTokens(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  const union = ta.size + tb.size - intersection;
  return intersection / union;
}

/**
 * Find an existing action that is a near-duplicate of the proposed one.
 *
 * Two-layer check:
 *   Layer 1 — same-source idempotency
 *     sourceRef matches AND text Jaccard ≥ 0.55 → skip re-import
 *   Layer 2 — cross-source merge
 *     Different sourceRef, text Jaccard ≥ 0.72, within 7 days, same owner →
 *     same action mentioned in multiple places; accumulate source refs
 *
 * Completed actions are excluded — we don't de-dup against done items.
 */
function findDuplicate(
  items: ActionItem[],
  text: string,
  sourceRef?: string,
  owner?: string
): ActionItem | null {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const candidateOwner = (owner ?? "").toLowerCase();

  for (const item of items) {
    if (item.status === "done") continue;

    // Layer 1 — idempotency: same sourceRef, similar text
    if (sourceRef && item.sourceRef === sourceRef) {
      if (jaccardSimilarity(text, item.text) >= 0.55) return item;
    }

    // Layer 2 — cross-source: high text overlap, recent, same owner
    const itemAge = new Date(item.createdAt).getTime();
    if (itemAge >= sevenDaysAgo && jaccardSimilarity(text, item.text) >= 0.72) {
      const itemOwner = (item.owner ?? "").toLowerCase();
      if (itemOwner === candidateOwner && candidateOwner !== "") return item;
    }
  }

  return null;
}

// ── Public interface ───────────────────────────────────────────────────────────

export async function listActions(username: string): Promise<ActionItem[]> {
  const items = await readAll(username);
  const t = today();
  // Compute overdue on-the-fly (not persisted) so stale data files don't matter
  const patched = items.map((a) =>
    a.status === "open" && a.dueDate && a.dueDate < t
      ? { ...a, status: "overdue" as const }
      : a
  );
  return patched.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export interface CreateActionInput {
  text: string;
  owner?: string;
  ownerId?: string;
  dueDate?: string;
  source?: ActionItem["source"];
  priority?: ActionPriority;
  /** 0–1 extraction confidence. */
  confidence?: number;
  /**
   * Set to true when confidence is in the review band.
   * Materialized by the trust policy layer; consumers should use
   * actionTier(confidence) from lib/trust/policy to derive this value.
   */
  needsReview?: boolean;
  /** Decision IDs this action is a consequence of. */
  linkedDecisionIds?: string[];
  /** Internal follow-up reminder date (YYYY-MM-DD). */
  followUpDate?: string;
  /** BasilEvent ID that produced this item (provenance). */
  eventId?: string;
  /** Stable source-system reference, e.g. "gmail:1abc2def". */
  sourceRef?: string;
  /**
   * Override initial status. Defaults to "open".
   * Use "done" when creating an already-completed record (e.g. an acknowledgment receipt).
   */
  status?: "open" | "done";
}

/**
 * Create an action with deduplication.
 *
 * - Same sourceRef + similar text → returns existing (idempotency)
 * - Cross-source near-duplicate → appends sourceRef to additionalSourceRefs,
 *   returns existing without creating a new row
 */
export async function createAction(username: string, input: CreateActionInput): Promise<ActionItem> {
  return withLock(lockKey(username), async () => {
    const items = await readAll(username);
    const now = new Date().toISOString();

    // Dedup check — skip or merge if a near-duplicate already exists
    const existing = findDuplicate(items, input.text, input.sourceRef, input.owner);
    if (existing) {
      // Accumulate the new sourceRef without creating a duplicate row
      if (input.sourceRef && input.sourceRef !== existing.sourceRef) {
        const idx = items.findIndex((a) => a.id === existing.id);
        if (idx !== -1) {
          const prev = items[idx].additionalSourceRefs ?? [];
          if (!prev.includes(input.sourceRef)) {
            items[idx] = {
              ...items[idx],
              additionalSourceRefs: [...prev, input.sourceRef],
              updatedAt: now,
            };
            await writeAll(username, items);
          }
        }
      }
      return existing;
    }

    const action: ActionItem = {
      id: `act-${randomUUID().slice(0, 8)}`,
      text: input.text.trim(),
      owner: (input.owner || "").trim(),
      ownerId: input.ownerId,
      dueDate: input.dueDate,
      status: input.status ?? "open",
      source: input.source ?? "manual",
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      eventId: input.eventId,
      sourceRef: input.sourceRef,
      ...(input.priority !== undefined && { priority: input.priority }),
      ...(input.confidence !== undefined && { confidence: input.confidence }),
      ...(input.needsReview !== undefined && { needsReview: input.needsReview }),
      ...(input.linkedDecisionIds?.length && { linkedDecisionIds: input.linkedDecisionIds }),
      ...(input.followUpDate && { followUpDate: input.followUpDate }),
    };
    items.unshift(action);
    await writeAll(username, items);
    return action;
  });
}

export async function updateAction(
  username: string,
  id: string,
  patch: Partial<
    Pick<
      ActionItem,
      | "text"
      | "owner"
      | "ownerId"
      | "dueDate"
      | "status"
      | "source"
      | "priority"
      | "confidence"
      | "needsReview"
      | "reviewDismissedAt"
      | "linkedDecisionIds"
      | "followUpDate"
      | "lastActivityAt"
    >
  >
): Promise<ActionItem | null> {
  return withLock(lockKey(username), async () => {
    const items = await readAll(username);
    const idx = items.findIndex((a) => a.id === id);
    if (idx === -1) return null;
    const now = new Date().toISOString();
    items[idx] = {
      ...items[idx],
      ...patch,
      updatedAt: now,
      // Touch lastActivityAt whenever there's a meaningful status change
      lastActivityAt:
        patch.status !== undefined || patch.lastActivityAt !== undefined
          ? (patch.lastActivityAt ?? now)
          : (items[idx].lastActivityAt ?? now),
    };
    await writeAll(username, items);
    return items[idx];
  });
}

export async function deleteAction(username: string, id: string): Promise<boolean> {
  return withLock(lockKey(username), async () => {
    const items = await readAll(username);
    const next = items.filter((a) => a.id !== id);
    if (next.length === items.length) return false;
    await writeAll(username, next);
    return true;
  });
}

/**
 * Link a decision to an action — appends decisionId to linkedDecisionIds (deduped).
 */
export async function linkDecisionToAction(
  username: string,
  actionId: string,
  decisionId: string
): Promise<ActionItem | null> {
  return withLock(lockKey(username), async () => {
    const items = await readAll(username);
    const idx = items.findIndex((a) => a.id === actionId);
    if (idx === -1) return null;
    const existing = items[idx].linkedDecisionIds ?? [];
    if (existing.includes(decisionId)) return items[idx];
    items[idx] = {
      ...items[idx],
      linkedDecisionIds: [...existing, decisionId],
      updatedAt: new Date().toISOString(),
    };
    await writeAll(username, items);
    return items[idx];
  });
}

export async function bulkImport(username: string, incoming: ActionItem[]): Promise<number> {
  return withLock(lockKey(username), async () => {
    const items = await readAll(username);
    const existingIds = new Set(items.map((a) => a.id));
    let added = 0;
    for (const a of incoming) {
      if (!existingIds.has(a.id)) {
        items.push(a);
        added++;
      }
    }
    if (added > 0) {
      items.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      await writeAll(username, items);
    }
    return added;
  });
}
