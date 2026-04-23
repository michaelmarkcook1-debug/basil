/**
 * Action store — persistent CRUD with:
 *   - Jaccard-similarity deduplication (two-layer: same-source idempotency +
 *     cross-source merge within 7 days)
 *   - Stale-action detection (open + no activity in 14 days + no due date)
 *   - Rich provenance tracking via sourceRef / additionalSourceRefs
 */

import { randomUUID } from "node:crypto";
import type { ActionItem, ActionPriority } from "@/lib/types/action";
import { withLock } from "@/lib/events/lock";
import { readStore, writeStore } from "@/lib/storage/persistent";
export { isActionStalled, STALE_THRESHOLD_DAYS } from "./utils";

const ACTIONS_FILE = "sage-actions.json";
const LOCK_KEY = "actions";

async function readAll(): Promise<ActionItem[]> {
  return readStore<ActionItem[]>(ACTIONS_FILE, []);
}

async function writeAll(items: ActionItem[]): Promise<void> {
  await writeStore(ACTIONS_FILE, items);
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
  const candidateOwner = (owner ?? "Michael Cook").toLowerCase();

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
      // Accept as duplicate if owners match OR both default to Michael Cook
      if (
        itemOwner === candidateOwner ||
        (itemOwner.includes("michael") && candidateOwner.includes("michael"))
      ) {
        return item;
      }
    }
  }

  return null;
}

// ── Public interface ───────────────────────────────────────────────────────────

export async function listActions(): Promise<ActionItem[]> {
  const items = await readAll();
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
export async function createAction(input: CreateActionInput): Promise<ActionItem> {
  return withLock(LOCK_KEY, async () => {
    const items = await readAll();
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
            await writeAll(items);
          }
        }
      }
      return existing;
    }

    const action: ActionItem = {
      id: `act-${randomUUID().slice(0, 8)}`,
      text: input.text.trim(),
      owner: (input.owner || "Michael Cook").trim(),
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
    await writeAll(items);
    return action;
  });
}

export async function updateAction(
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
  return withLock(LOCK_KEY, async () => {
    const items = await readAll();
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
    await writeAll(items);
    return items[idx];
  });
}

export async function deleteAction(id: string): Promise<boolean> {
  return withLock(LOCK_KEY, async () => {
    const items = await readAll();
    const next = items.filter((a) => a.id !== id);
    if (next.length === items.length) return false;
    await writeAll(next);
    return true;
  });
}

/**
 * Link a decision to an action — appends decisionId to linkedDecisionIds (deduped).
 */
export async function linkDecisionToAction(
  actionId: string,
  decisionId: string
): Promise<ActionItem | null> {
  return withLock(LOCK_KEY, async () => {
    const items = await readAll();
    const idx = items.findIndex((a) => a.id === actionId);
    if (idx === -1) return null;
    const existing = items[idx].linkedDecisionIds ?? [];
    if (existing.includes(decisionId)) return items[idx];
    items[idx] = {
      ...items[idx],
      linkedDecisionIds: [...existing, decisionId],
      updatedAt: new Date().toISOString(),
    };
    await writeAll(items);
    return items[idx];
  });
}

export async function bulkImport(incoming: ActionItem[]): Promise<number> {
  return withLock(LOCK_KEY, async () => {
    const items = await readAll();
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
      await writeAll(items);
    }
    return added;
  });
}
