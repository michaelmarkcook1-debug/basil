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
import { classifyAction } from "./classify";
import {
  isOverdueStale,
  isGroupOwner,
  isMeetingAttendancePast,
} from "./utils";
import { getSelfIdentity } from "@/lib/self-identity";
export {
  isActionStalled,
  isOverdueStale,
  isGroupOwner,
  isMeetingAttendancePast,
  STALE_THRESHOLD_DAYS,
  STALE_OVERDUE_THRESHOLD_DAYS,
} from "./utils";

const ACTIONS_FILE = "sage-actions.json";

function lockKey(username: string): string {
  return `actions:${username}`;
}

/**
 * ⚠️ EVERY read that feeds a read-modify-write MUST pass `{ fresh: true }`.
 *
 * Without it the read comes from the per-instance /tmp cache, which has no TTL.
 * That silently defeats the surrounding `withLock`: the lock serialises the
 * write, but the value being written was derived from a snapshot that may be
 * minutes old, so this instance happily overwrites actions another instance
 * created — a lost update the lock was supposed to prevent.
 *
 * The only read that may skip it is the caller-controlled list read below,
 * where the caller decides its own freshness. Pattern reference:
 * lib/google/watch-state.ts (lock + fresh together).
 */
async function readAll(username: string, options?: { fresh?: boolean }): Promise<ActionItem[]> {
  return readUserStore<ActionItem[]>(username, ACTIONS_FILE, [], options);
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

/** Canonical form for exact-duplicate comparison: case/punct/whitespace-blind. */
function normalizeExact(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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
 * Extract key entities from action text for entity-aware deduplication.
 *
 * Captures:
 *   - Normalised clock times ("11:30 AM" → "11:30am", "11:30" → "11:30")
 *   - Day/date words ("tuesday", "may 6")
 *   - Proper-noun sequences (runs of Title-case words: "Roger Stringer")
 *
 * These high-signal anchors let us catch semantic duplicates like
 * "Confirm attendance for 11:30 AM meeting with Roger Stringer" vs
 * "Confirm or decline 11:30 AM meeting slot with Roger Stringer"
 * even when Jaccard alone falls just below the threshold.
 */
function extractKeyEntities(text: string): Set<string> {
  const entities = new Set<string>();

  // Times: 11:30 AM, 1:00pm, 11:30
  for (const m of text.matchAll(/\b(\d{1,2}:\d{2})\s*(am|pm)?\b/gi)) {
    entities.add(`${m[1]}${(m[2] ?? "").toLowerCase()}`);
  }

  // Standalone hour with am/pm: 3pm, 11am
  for (const m of text.matchAll(/\b(\d{1,2})(am|pm)\b/gi)) {
    entities.add(`${m[1]}${m[2].toLowerCase()}`);
  }

  // Days of week
  for (const m of text.matchAll(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi)) {
    entities.add(m[1].toLowerCase());
  }

  // Month + day: "May 6", "6th May"
  for (const m of text.matchAll(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}\b/gi)) {
    entities.add(m[0].toLowerCase());
  }

  // Proper-noun sequences: runs of 1-3 Title-case words (person names, company names)
  for (const m of text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g)) {
    // Skip single generic words that are just capitalised at sentence start
    const words = m[1].split(/\s+/);
    if (words.length >= 2 || (words.length === 1 && m[1].length >= 4)) {
      entities.add(m[1].toLowerCase());
    }
  }

  return entities;
}

/**
 * Count shared key entities between two action texts.
 * Two or more shared entities (e.g. "roger stringer" + "11:30am") is a
 * strong signal that the actions refer to the same real-world event.
 */
function sharedKeyEntityCount(a: string, b: string): number {
  const ka = extractKeyEntities(a);
  const kb = extractKeyEntities(b);
  let count = 0;
  for (const e of ka) if (kb.has(e)) count++;
  return count;
}

/**
 * Find an existing action that is a near-duplicate of the proposed one.
 *
 * Four-layer check:
 *   Layer 1 — same-source idempotency
 *     sourceRef matches AND text Jaccard ≥ 0.55 → skip re-import
 *   Layer 1.5 — high-confidence text match regardless of owner
 *     Jaccard ≥ 0.85, within 7 days → catches approval/needsReview items
 *     with empty owners that would otherwise slip through layers 2+3.
 *     e.g. three identical "Drafted reply — Slack in #dev" items.
 *   Layer 2 — cross-source text overlap
 *     Jaccard ≥ 0.65, within 7 days, same owner → merge source refs
 *   Layer 3 — entity-aware semantic match
 *     Jaccard ≥ 0.55, same owner, ≥2 shared key entities (person + time),
 *     within 7 days → catches paraphrased duplicates like
 *     "Confirm attendance … Roger Stringer" vs "Confirm or decline … Roger Stringer"
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

    // Layer 0 — EXACT text match against ANY open item, age-unbounded.
    // The 7-day bound below keeps the fuzzy layers cheap and avoids merging
    // legitimately recurring tasks, but an IDENTICAL text while the original
    // is still open is a duplicate at any age. Without this, a recurring
    // calendar invite re-ingested >7 days after the original action minted a
    // new identical row every time (each email has a fresh sourceRef, so
    // layer 1 never fires): observed live as 4 visible copies of the same
    // "Respond to scheduling request from Olivia…" commitment.
    if (normalizeExact(text) === normalizeExact(item.text)) return item;

    // Layer 1 — idempotency: same sourceRef, similar text
    if (sourceRef && item.sourceRef === sourceRef) {
      if (jaccardSimilarity(text, item.text) >= 0.55) return item;
    }

    const itemAge = new Date(item.createdAt).getTime();
    if (itemAge < sevenDaysAgo) continue; // layers 1.5+2+3 are time-bounded

    const sim = jaccardSimilarity(text, item.text);

    // Layer 1.5 — high-confidence text match, owner-agnostic
    // Approval/needsReview items often have empty owners; without this layer
    // repeated syncs create N identical rows because sameOwner is always false
    // for empty-owner pairs. sim ≥ 0.85 is safe to merge unconditionally.
    if (sim >= 0.85) return item;

    const itemOwner = (item.owner ?? "").toLowerCase();
    const sameOwner = itemOwner === candidateOwner && candidateOwner !== "";

    // Layer 2 — cross-source high text overlap (threshold lowered 0.72→0.65)
    if (sim >= 0.65 && sameOwner) return item;

    // Layer 3 — entity-aware: moderate text overlap + shared key entities
    // Catches paraphrased duplicates that just miss the Jaccard threshold
    if (sim >= 0.55 && sameOwner && sharedKeyEntityCount(text, item.text) >= 2) {
      return item;
    }
  }

  return null;
}

/**
 * Scan the existing action list for duplicates introduced before the improved
 * dedup logic and merge them in-place.  Returns the cleaned list and whether
 * any merges happened (so the caller can decide whether to persist).
 *
 * Merge strategy: keep the OLDER item (richer provenance), accumulate
 * sourceRefs from the newer one, then discard the newer duplicate.
 */
function mergeExistingDuplicates(items: ActionItem[]): { items: ActionItem[]; changed: boolean } {
  const now = new Date().toISOString();
  const toRemove = new Set<string>();
  const merged = items.map((a) => ({ ...a })); // shallow clone for mutation

  for (let i = 0; i < merged.length; i++) {
    if (toRemove.has(merged[i].id) || merged[i].status === "done") continue;

    for (let j = i + 1; j < merged.length; j++) {
      if (toRemove.has(merged[j].id) || merged[j].status === "done") continue;

      const a = merged[i];
      const b = merged[j];
      const ownerA = (a.owner ?? "").toLowerCase();
      const ownerB = (b.owner ?? "").toLowerCase();

      const ageA = new Date(a.createdAt).getTime();
      const ageB = new Date(b.createdAt).getTime();
      // Only consider pairs created within 7 days of each other
      if (Math.abs(ageA - ageB) > 7 * 24 * 60 * 60 * 1000) continue;
      // Both must be recent (within 30 days)
      if (Math.min(ageA, ageB) < Date.now() - 30 * 24 * 60 * 60 * 1000) continue;

      const sim = jaccardSimilarity(a.text, b.text);
      const entityOverlap = sharedKeyEntityCount(a.text, b.text);

      // For very high text similarity (≥0.85), merge regardless of owner
      // so that approval / needsReview items with blank owner dedup correctly.
      // For lower similarity, require matching non-empty owners as before.
      const highConfidenceDup = sim >= 0.85;
      if (!highConfidenceDup) {
        if (ownerA !== ownerB || ownerA === "") continue;
      }

      const isDup = highConfidenceDup || sim >= 0.65 || (sim >= 0.55 && entityOverlap >= 2);
      if (!isDup) continue;

      // Keep older item (lower age ms = created earlier)
      const [keepIdx, dropIdx] = ageA <= ageB ? [i, j] : [j, i];
      const keep = merged[keepIdx];
      const drop = merged[dropIdx];

      // Accumulate sourceRefs from the dropped item
      const existing = keep.additionalSourceRefs ?? [];
      const toAdd = [drop.sourceRef, ...(drop.additionalSourceRefs ?? [])]
        .filter((r): r is string => !!r && r !== keep.sourceRef && !existing.includes(r));

      if (toAdd.length > 0) {
        merged[keepIdx] = {
          ...keep,
          additionalSourceRefs: [...existing, ...toAdd],
          updatedAt: now,
        };
      }

      toRemove.add(drop.id);
    }
  }

  if (toRemove.size === 0) return { items, changed: false };

  const cleaned = merged.filter((a) => !toRemove.has(a.id));
  return { items: cleaned, changed: true };
}

// ── Public interface ───────────────────────────────────────────────────────────

export async function listActions(username: string, options?: { fresh?: boolean }): Promise<ActionItem[]> {
  const items = await readAll(username, options);

  // ── Dedup cleanup pass ──────────────────────────────────────────────────────
  // Catches duplicates that slipped through before the improved dedup logic.
  // Fire-and-forget: re-reads inside the lock to avoid races; never blocks the
  // response — the deduped view is returned to the caller immediately.
  const { items: deduped, changed: dedupChanged } = mergeExistingDuplicates(items);
  const needsCategory = deduped.filter((a) => a.category === undefined && a.status !== "done");

  // ── Background maintenance: ONE lock, both passes ────────────────────────────
  // These used to be two separate fire-and-forget withLock() calls on the SAME
  // key, launched back-to-back. While the lock silently degraded to an
  // in-process mutex that was survivable; the moment Upstash made it a real
  // cross-instance lock they began contending with each other (and with every
  // concurrent listActions), producing
  // "[lock] could not acquire actions:<user> after 30 attempts" on /api/today.
  //
  // They also both did read → mutate → write over the same store, so running
  // them separately meant two Blob reads and two writes to accomplish what one
  // pass can. Combined: one acquisition, one read, at most one write.
  if (dedupChanged || needsCategory.length > 0) {
    withLock(lockKey(username), async () => {
      const current = await readAll(username, { fresh: true });

      const { items: clean, changed: cleanChanged } = mergeExistingDuplicates(current);
      let changed = cleanChanged;

      const patched = clean.map((a) => {
        if (a.category !== undefined || a.status === "done") return a;
        const result = classifyAction(a.text, a.priority);
        if (result.category === undefined && !result.decisionRequired) return a;
        changed = true;
        return {
          ...a,
          ...(result.category     !== undefined && { category: result.category }),
          ...(result.decisionRequired            && { decisionRequired: true }),
        };
      });

      if (changed) await writeAll(username, patched);
    }).catch((err) => console.error("[actions] background maintenance failed:", err));
  }

  // ── Owner filter — group refs and named third-parties ──────────────────────
  // Remove actions whose owner field is:
  //   (a) a Slack channel / @mention / team reference  (isGroupOwner)
  //   (b) a named person who is clearly not the current user
  //       e.g. "Jamie Brooks" when the current user is someone else
  //
  // Pattern for (b): owner contains at least one space (looks like a name),
  // does NOT match any of the user's known names or first-person pronouns,
  // and is not blank / "unknown" / "me".
  // Persist the cleanup so orphaned rows stop re-appearing across deploys.
  const selfIdentity = await getSelfIdentity(username).catch(() => ({ emails: [], names: [] }));
  const selfNameTokens = selfIdentity.names.map((n) => n.toLowerCase());

  function isOtherPersonOwner(owner: string | undefined): boolean {
    if (!owner?.trim()) return false;
    const o = owner.trim().toLowerCase();
    // First-person / ambiguous labels → keep
    if (o === "me" || o === "i" || o === "unknown" || o === "self") return false;
    // Group-style → handled by isGroupOwner
    if (isGroupOwner(owner)) return false;
    // Matches one of the user's known name tokens → keep
    if (selfNameTokens.length > 0) {
      if (selfNameTokens.some((n) => o.includes(n) || n.includes(o))) return false;
    }
    // Looks like a two-part personal name (First Last) → someone else → exclude
    return /^[a-z]+ [a-z]/i.test(owner.trim());
  }

  // Auto-extracted items (slack, email, calendar) whose owner could not be
  // identified are inherently ambiguous — they might belong to anyone in the
  // conversation.  Once overdue they become permanent noise: we surfaced them,
  // the window passed, and we still don't know if they were even the user's.
  // Drop them rather than keep escalating them as critical/overdue.
  function isUnknownOwnerOverdue(a: ActionItem): boolean {
    if ((a.source ?? "manual") === "manual") return false; // user-created → always keep
    const owner = (a.owner ?? "").trim().toLowerCase();
    if (owner !== "" && owner !== "unknown") return false; // has an identified owner
    // No identified owner + overdue → unverifiable, surface as noise → drop
    const t2 = today();
    return a.status === "overdue" || (a.status === "open" && !!a.dueDate && a.dueDate < t2);
  }

  const isNotMine = (a: ActionItem) =>
    isGroupOwner(a.owner) || isOtherPersonOwner(a.owner) || isUnknownOwnerOverdue(a);
  const notMineItems = deduped.filter(isNotMine);

  if (notMineItems.length > 0) {
    withLock(lockKey(username), async () => {
      const current = await readAll(username, { fresh: true });
      const cleaned = current.filter(
        (a) => !isGroupOwner(a.owner) && !isOtherPersonOwner(a.owner) && !isUnknownOwnerOverdue(a)
      );
      if (cleaned.length !== current.length) {
        await writeAll(username, cleaned);
        console.log(
          `[actions] purged ${current.length - cleaned.length} non-personal action(s) for ${username}`
        );
      }
    }).catch((err) => console.error("[actions] owner purge failed:", err));
  }
  const personalOnly = deduped.filter((a) => !isNotMine(a));

  const t = today();
  // Compute overdue on-the-fly (not persisted) so stale data files don't matter
  const withOverdue = personalOnly.map((a) =>
    a.status === "open" && a.dueDate && a.dueDate < t
      ? { ...a, status: "overdue" as const }
      : a
  );

  // ── Stale-overdue auto-archive ───────────────────────────────────────────────
  // Auto-extracted commitments (Slack, email) with a specific due date that
  // passed 14+ days ago and were never manually acknowledged are moved to
  // "done".  The original window is long closed; showing them as critical
  // indefinitely creates noise rather than signal.
  const staleOverdue = withOverdue.filter((a) => isOverdueStale(a));
  if (staleOverdue.length > 0) {
    const staleIds = new Set(staleOverdue.map((a) => a.id));
    withLock(lockKey(username), async () => {
      const current = await readAll(username, { fresh: true });
      let changed = false;
      const archived = current.map((a) => {
        if (!staleIds.has(a.id) || a.status === "done") return a;
        changed = true;
        return {
          ...a,
          status: "done" as const,
          archivedReason: "stale-overdue" as const,
          updatedAt: new Date().toISOString(),
        };
      });
      if (changed) {
        await writeAll(username, archived);
        console.log(
          `[actions] auto-archived ${staleOverdue.length} stale-overdue action(s) for ${username}`
        );
      }
    }).catch((err) => console.error("[actions] stale-overdue archive failed:", err));
  }
  const staleIds = new Set(staleOverdue.map((a) => a.id));
  const afterStale = withOverdue.map((a) =>
    staleIds.has(a.id) ? { ...a, status: "done" as const, archivedReason: "stale-overdue" as const } : a
  );

  // ── Past-meeting attendance auto-archive ─────────────────────────────────────
  // "Attend meeting…" / "Join call with…" type actions become meaningless once
  // the meeting time has passed. Archive them silently after a grace period so
  // they don't accumulate as permanent overdue noise.
  const pastMeeting = afterStale.filter((a) => isMeetingAttendancePast(a));
  if (pastMeeting.length > 0) {
    const pastMeetingIds = new Set(pastMeeting.map((a) => a.id));
    withLock(lockKey(username), async () => {
      const current = await readAll(username, { fresh: true });
      let changed = false;
      const archived = current.map((a) => {
        if (!pastMeetingIds.has(a.id) || a.status === "done") return a;
        changed = true;
        return { ...a, status: "done" as const, archivedReason: "past-meeting" as const, updatedAt: new Date().toISOString() };
      });
      if (changed) {
        await writeAll(username, archived);
        console.log(
          `[actions] auto-archived ${pastMeeting.length} past-meeting attendance action(s) for ${username}`
        );
      }
    }).catch((err) => console.error("[actions] past-meeting archive failed:", err));
  }
  const pastMeetingIds = new Set(pastMeeting.map((a) => a.id));
  const afterPastMeeting = afterStale.map((a) =>
    pastMeetingIds.has(a.id) ? { ...a, status: "done" as const, archivedReason: "past-meeting" as const } : a
  );

  // ── Time-bounded expiry auto-archive ─────────────────────────────────────────
  // Actions whose expiresAt has passed are silently archived — they were only
  // relevant within a specific window ("meeting in 30 mins", "by EOD today") and
  // keeping them open creates noise rather than signal.
  const now = new Date();
  const expired = afterPastMeeting.filter(
    (a) => a.expiresAt && new Date(a.expiresAt) < now && a.status !== "done"
  );
  if (expired.length > 0) {
    const expiredIds = new Set(expired.map((a) => a.id));
    withLock(lockKey(username), async () => {
      const current = await readAll(username, { fresh: true });
      let changed = false;
      const archived = current.map((a) => {
        if (!expiredIds.has(a.id) || a.status === "done") return a;
        changed = true;
        return { ...a, status: "done" as const, archivedReason: "expired" as const, updatedAt: new Date().toISOString() };
      });
      if (changed) {
        await writeAll(username, archived);
        console.log(`[actions] archived ${expired.length} expired time-bounded action(s) for ${username}`);
      }
    }).catch((err) => console.error("[actions] expiry archive failed:", err));
  }
  const expiredIds = new Set(expired.map((a) => a.id));
  const live = afterPastMeeting.map((a) =>
    expiredIds.has(a.id) ? { ...a, status: "done" as const, archivedReason: "expired" as const } : a
  );

  return live.sort(
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
  /**
   * ISO timestamp at which this action auto-expires (see ActionItem.expiresAt).
   * Set when the message contained time-relative language like "in 30 minutes".
   */
  expiresAt?: string;
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
    const items = await readAll(username, { fresh: true });
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

    // Auto-classify: derive category + decision flag from action text
    const { category, decisionRequired } = classifyAction(
      input.text.trim(),
      input.priority,
    );

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
      ...(input.expiresAt && { expiresAt: input.expiresAt }),
      // Classification
      ...(category         !== undefined && { category }),
      ...(decisionRequired               && { decisionRequired: true }),
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
      | "category"
      | "decisionRequired"
      | "linkedDecisionId"
      | "eisenhower"
      | "eisenhowerReason"
      | "eisenhowerClassifiedAt"
      // Signal-driven auto-resolution (calendar RSVP, sent reply) marks an
      // action done AND tags why — so it lands in Done as "you accepted /
      // replied", not conflated with genuinely hand-completed work.
      | "archivedReason"
    >
  >
): Promise<ActionItem | null> {
  return withLock(lockKey(username), async () => {
    const items = await readAll(username, { fresh: true });
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
    const items = await readAll(username, { fresh: true });
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
    const items = await readAll(username, { fresh: true });
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

// ── Tracked variant (idempotency layer) ───────────────────────────────────────

export interface CreateActionResult {
  item: ActionItem;
  /** True when a new row was inserted; false when an existing item was returned. */
  created: boolean;
}

/**
 * Like createAction but also reports whether the item was newly created.
 * Used by the ingest layer to emit accurate audit entries.
 */
export async function createActionTracked(
  username: string,
  input: CreateActionInput
): Promise<CreateActionResult> {
  // Read a snapshot of existing IDs before the create call.
  // The create call acquires its own lock internally.
  const before = await readAll(username, { fresh: true });
  const existingIds = new Set(before.map((a) => a.id));
  const item = await createAction(username, input);
  return { item, created: !existingIds.has(item.id) };
}

export async function bulkImport(username: string, incoming: ActionItem[]): Promise<number> {
  return withLock(lockKey(username), async () => {
    const items = await readAll(username, { fresh: true });
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
