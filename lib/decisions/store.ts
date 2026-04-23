import { randomUUID } from "node:crypto";
import type { Decision } from "@/lib/types/decision";
import { withLock } from "@/lib/events/lock";
import { readStore, writeStore } from "@/lib/storage/persistent";

const DECISIONS_FILE = "sage-decisions.json";
const LOCK_KEY = "decisions";

async function readAll(): Promise<Decision[]> {
  return readStore<Decision[]>(DECISIONS_FILE, []);
}

async function writeAll(items: Decision[]): Promise<void> {
  await writeStore(DECISIONS_FILE, items);
}

export async function listDecisions(): Promise<Decision[]> {
  const items = await readAll();
  // Fall back to createdAt when date is absent or invalid to avoid NaN in sort.
  return items.sort(
    (a, b) =>
      new Date(b.date || b.createdAt).getTime() -
      new Date(a.date || a.createdAt).getTime()
  );
}

// ── Dedup helpers ──────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "to", "and", "or", "of",
  "in", "on", "at", "for", "with", "that", "this", "it", "we", "has",
  "have", "be", "been", "will", "would", "should", "could", "by", "as",
  "not", "but", "so", "if", "do", "did", "from", "about", "its",
]);

function wordTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
  );
}

/**
 * Jaccard similarity between two text strings based on significant word tokens.
 * Returns 0–1; higher = more similar.
 */
function jaccardSimilarity(a: string, b: string): number {
  const setA = wordTokens(a);
  const setB = wordTokens(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

/**
 * Minimum Jaccard similarity to treat two decisions as the same.
 * 0.65 is intentionally high to avoid false-positive merges.
 */
const DEDUP_SIMILARITY_THRESHOLD = 0.65;

/** Maximum age (days) to consider a decision for semantic dedup. */
const DEDUP_WINDOW_DAYS = 14;

const MS_PER_DAY = 86_400_000;

/**
 * Find an existing decision that is semantically equivalent to `text`.
 * Returns the matching decision or null.
 *
 * Checks:
 *  1. Same sourceRef (exact dedup — identical source record)
 *  2. Text Jaccard similarity ≥ threshold within the dedup window
 */
function findDuplicate(
  items: Decision[],
  text: string,
  sourceRef?: string
): Decision | null {
  const cutoff = Date.now() - DEDUP_WINDOW_DAYS * MS_PER_DAY;

  for (const d of items) {
    // 1) Exact sourceRef match (same physical record ingested twice)
    if (sourceRef) {
      if (d.sourceRef === sourceRef) return d;
      if (d.additionalSourceRefs?.includes(sourceRef)) return d;
    }

    // 2) Semantic similarity within the dedup window.
    // Fall back to createdAt when date is absent or invalid — avoids NaN
    // comparisons that would incorrectly include all undated decisions as candidates.
    const decisionDate = new Date(d.date || d.createdAt).getTime();
    if (isNaN(decisionDate) || decisionDate < cutoff) continue; // too old
    if (jaccardSimilarity(d.text, text) >= DEDUP_SIMILARITY_THRESHOLD) return d;
  }

  return null;
}

// ── Input type ─────────────────────────────────────────────────────────────────

export interface CreateDecisionInput {
  /** Full decision statement (required). */
  text: string;
  /** Short scannable headline (optional). */
  title?: string;
  /** Executive summary — richer than text. */
  summary?: string;
  /** Why this decision was made. */
  rationale?: string;
  /** Alternatives explicitly considered. */
  alternatives?: string[];
  /** Expected follow-ups or consequences. */
  consequences?: string[];

  /** Primary decision-maker. */
  decidedBy: string;
  decidedById?: string;
  /** Other explicitly named stakeholders. */
  stakeholders?: string[];

  date?: string;
  context?: string;
  source?: Decision["source"];
  confidence?: number;
  /**
   * Set to true when confidence is in the review band (0.45–0.69).
   * Use decisionTier(confidence) from lib/trust/policy to derive this value.
   */
  needsReview?: boolean;
  tags?: string[];
  /** IDs of follow-up actions created alongside this decision. */
  linkedActionIds?: string[];

  /** BasilEvent ID that produced this decision (provenance). */
  eventId?: string;
  /** Stable source-system reference (provenance), e.g. "gmail:1abc2def". */
  sourceRef?: string;
}

// ── Core CRUD ──────────────────────────────────────────────────────────────────

/**
 * Create a new decision, with dedup guards.
 *
 * Dedup behaviour:
 *  - If an existing decision shares the same `sourceRef`, return it unchanged.
 *  - If an existing recent decision has Jaccard similarity ≥ 0.65, append the new
 *    sourceRef to `additionalSourceRefs` and return the existing record.
 *  - Otherwise, create a new record.
 */
export async function createDecision(input: CreateDecisionInput): Promise<Decision> {
  return withLock(LOCK_KEY, async () => {
    const items = await readAll();
    const now = new Date().toISOString();

    // ── Dedup check ────────────────────────────────────────────────────────
    const existing = findDuplicate(items, input.text, input.sourceRef);
    if (existing) {
      // If we have a new sourceRef that isn't already recorded, append it
      if (
        input.sourceRef &&
        input.sourceRef !== existing.sourceRef &&
        !existing.additionalSourceRefs?.includes(input.sourceRef)
      ) {
        const idx = items.findIndex((d) => d.id === existing.id);
        if (idx !== -1) {
          items[idx] = {
            ...items[idx],
            additionalSourceRefs: [
              ...(items[idx].additionalSourceRefs ?? []),
              input.sourceRef,
            ],
            updatedAt: now,
          };
          await writeAll(items);
          console.log(
            `[decisions] dedup: merged sourceRef "${input.sourceRef}" into existing decision ${existing.id}`
          );
          return items[idx];
        }
      }
      console.log(
        `[decisions] dedup: skipped duplicate for "${input.text.slice(0, 60)}" (matches ${existing.id})`
      );
      return existing;
    }

    // ── Create new record ──────────────────────────────────────────────────
    const decision: Decision = {
      id: `dec-${randomUUID().slice(0, 8)}`,
      text: input.text.trim(),
      title: input.title?.trim(),
      summary: input.summary?.trim(),
      rationale: input.rationale?.trim(),
      alternatives: input.alternatives?.filter(Boolean),
      consequences: input.consequences?.filter(Boolean),
      decidedBy: input.decidedBy.trim(),
      decidedById: input.decidedById,
      stakeholders: input.stakeholders?.filter(Boolean),
      date: input.date || now.slice(0, 10),
      context: input.context?.trim() || "",
      status: "active",
      source: input.source,
      confidence: input.confidence,
      ...(input.needsReview !== undefined && { needsReview: input.needsReview }),
      tags: input.tags?.filter(Boolean),
      linkedActionIds: input.linkedActionIds?.filter(Boolean),
      createdAt: now,
      updatedAt: now,
      eventId: input.eventId,
      sourceRef: input.sourceRef,
    };

    items.unshift(decision);
    await writeAll(items);
    return decision;
  });
}

export async function updateDecision(
  id: string,
  patch: Partial<
    Pick<
      Decision,
      | "text"
      | "title"
      | "summary"
      | "rationale"
      | "alternatives"
      | "consequences"
      | "decidedBy"
      | "decidedById"
      | "stakeholders"
      | "date"
      | "context"
      | "status"
      | "source"
      | "confidence"
      | "needsReview"
      | "reviewDismissedAt"
      | "tags"
      | "linkedActionIds"
    >
  >
): Promise<Decision | null> {
  return withLock(LOCK_KEY, async () => {
    const items = await readAll();
    const idx = items.findIndex((d) => d.id === id);
    if (idx === -1) return null;
    items[idx] = { ...items[idx], ...patch, updatedAt: new Date().toISOString() };
    await writeAll(items);
    return items[idx];
  });
}

/**
 * Append a linked action ID to a decision (idempotent — no duplicates added).
 */
export async function linkActionToDecision(
  decisionId: string,
  actionId: string
): Promise<Decision | null> {
  return withLock(LOCK_KEY, async () => {
    const items = await readAll();
    const idx = items.findIndex((d) => d.id === decisionId);
    if (idx === -1) return null;
    const existing = items[idx].linkedActionIds ?? [];
    if (existing.includes(actionId)) return items[idx]; // already linked
    items[idx] = {
      ...items[idx],
      linkedActionIds: [...existing, actionId],
      updatedAt: new Date().toISOString(),
    };
    await writeAll(items);
    return items[idx];
  });
}

export async function deleteDecision(id: string): Promise<boolean> {
  return withLock(LOCK_KEY, async () => {
    const items = await readAll();
    const next = items.filter((d) => d.id !== id);
    if (next.length === items.length) return false;
    await writeAll(next);
    return true;
  });
}

export async function bulkImport(incoming: Decision[]): Promise<number> {
  return withLock(LOCK_KEY, async () => {
    const items = await readAll();
    const existingIds = new Set(items.map((d) => d.id));
    let added = 0;
    for (const d of incoming) {
      if (!existingIds.has(d.id)) {
        items.push(d);
        added++;
      }
    }
    if (added > 0) {
      items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      await writeAll(items);
    }
    return added;
  });
}
