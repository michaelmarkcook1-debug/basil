import { randomUUID } from "node:crypto";
import type { Memory, MemoryKind } from "./types";
import { withLock } from "@/lib/events/lock";
import { readUserStore, writeUserStore } from "@/lib/storage/user-store";

const MEMORY_FILE = "sage-memory.json";
/** Rolling lifetime of a `context` memory, per basil/memory/SPEC.md §1.3. */
export const CONTEXT_TTL_DAYS = 7;
const contextExpiry = (from = Date.now()) => new Date(from + CONTEXT_TTL_DAYS * 86_400_000).toISOString();

/** A memory that has aged out. Never true for pinned or non-context memories. */
export function isExpired(m: Pick<Memory, "kind" | "pinned" | "expiresAt">, now = Date.now()): boolean {
  if (m.pinned) return false;
  if (!m.expiresAt) return false;
  return new Date(m.expiresAt).getTime() < now;
}

// Lock key is per-user so concurrent writes from different users don't block each other
function lockKey(username: string) {
  return `memory:${username}`;
}

/**
 * `fresh: true` bypasses the /tmp write-through cache and re-reads the durable
 * store. EVERY read inside a withLock() read-modify-write MUST pass it.
 *
 * The lock gives mutual exclusion on this instance; it says nothing about
 * whether the cached array is current. Two warm instances that had each
 * listed memories, then each saved one, ended with only the second save
 * durable — the first instance's write was read back through a cache that
 * predated it and overwritten. lib/events/store.ts and lib/actions/store.ts
 * carry the same fix for the same reason; this store was missed because it
 * looked correct: it *does* hold the lock.
 */
async function readAll(username: string, options?: { fresh?: boolean }): Promise<Memory[]> {
  return readUserStore<Memory[]>(username, MEMORY_FILE, [], options);
}

async function writeAll(username: string, items: Memory[]): Promise<void> {
  await writeUserStore(username, MEMORY_FILE, items);
}

export async function listMemories(username: string): Promise<Memory[]> {
  const items = await readAll(username);
  // Newest first
  return items.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export async function getMemoriesForEntity(username: string, entity: string): Promise<Memory[]> {
  const items = await readAll(username);
  const target = entity.toLowerCase();
  return items.filter((m) => m.entity?.toLowerCase() === target);
}

export interface CreateMemoryInput {
  kind: MemoryKind;
  content: string;
  entity?: string;
  source?: Memory["source"];
  /** 0–1 confidence for inferred memories. Absent on manually-created items. */
  confidence?: number;
  /** True when confidence is in the review band — user may want to verify. */
  needsReview?: boolean;
  /** BasilEvent ID that produced this memory (provenance). */
  eventId?: string;
  /** Stable source-system reference (provenance), e.g. "gmail:1abc2def". */
  sourceRef?: string;
}

export async function createMemory(username: string, input: CreateMemoryInput): Promise<Memory> {
  return withLock(lockKey(username), async () => {
    const items = await readAll(username, { fresh: true });
    const now = new Date().toISOString();

    // Dedupe layer 1 — same sourceRef: return existing without bumping updatedAt
    // (avoids re-writing the same record on every replay of the same source message)
    if (input.sourceRef) {
      const byRef = items.find((m) => m.sourceRef === input.sourceRef &&
        m.content.trim().toLowerCase() === input.content.trim().toLowerCase());
      if (byRef) return byRef;
    }

    // Dedupe layer 2 — identical content+entity (cross-source or manual dedup):
    // bump updatedAt so "last seen" recency is kept up to date
    const existingIdx = items.findIndex(
      (m) =>
        m.content.trim().toLowerCase() === input.content.trim().toLowerCase() &&
        (m.entity ?? "").toLowerCase() === (input.entity ?? "").toLowerCase()
    );
    if (existingIdx !== -1) {
      items[existingIdx] = { ...items[existingIdx], updatedAt: now };
      await writeAll(username, items);
      return items[existingIdx];
    }

    const memory: Memory = {
      id: randomUUID(),
      kind: input.kind,
      content: input.content.trim(),
      entity: input.entity?.trim() || undefined,
      source: input.source ?? "chat",
      createdAt: now,
      updatedAt: now,
      ...(input.confidence !== undefined && { confidence: input.confidence }),
      ...(input.needsReview !== undefined && { needsReview: input.needsReview }),
      eventId: input.eventId,
      sourceRef: input.sourceRef,
      ...(input.kind === "context" ? { expiresAt: contextExpiry() } : {}),
    };
    items.unshift(memory);
    await writeAll(username, items);
    return memory;
  });
}

// ── Tracked variant (idempotency layer) ───────────────────────────────────────

export interface CreateMemoryResult {
  item: Memory;
  /** True when a new row was inserted; false when an existing item was returned. */
  created: boolean;
}

/**
 * Like createMemory but also reports whether the item was newly created.
 * Used by the ingest layer to emit accurate audit entries.
 */
export async function createMemoryTracked(
  username: string,
  input: CreateMemoryInput
): Promise<CreateMemoryResult> {
  // Fresh: a stale snapshot here would report a dedupe hit as a creation.
  const before = await readAll(username, { fresh: true });
  const existingIds = new Set(before.map((m) => m.id));
  const item = await createMemory(username, input);
  return { item, created: !existingIds.has(item.id) };
}

export async function updateMemory(
  username: string,
  id: string,
  patch: Partial<Pick<Memory, "content" | "kind" | "entity" | "pinned">>
): Promise<Memory | null> {
  return withLock(lockKey(username), async () => {
    const items = await readAll(username, { fresh: true });
    const idx = items.findIndex((m) => m.id === id);
    if (idx === -1) return null;
    const next: Memory = { ...items[idx], ...patch, updatedAt: new Date().toISOString() };
    // Touching a context memory renews its week; changing kind sets or clears the clock.
    if (next.kind === "context") next.expiresAt = contextExpiry();
    else delete next.expiresAt;
    items[idx] = next;
    await writeAll(username, items);
    return items[idx];
  });
}

export async function deleteMemory(username: string, id: string): Promise<boolean> {
  return withLock(lockKey(username), async () => {
    const items = await readAll(username, { fresh: true });
    const next = items.filter((m) => m.id !== id);
    if (next.length === items.length) return false;
    await writeAll(username, next);
    return true;
  });
}

// Maximum items per kind and total emitted by memoriesForPrompt.
// Keeps prompt context bounded even when the store grows large.
const PROMPT_MAX_PER_KIND = 10;
const PROMPT_MAX_TOTAL = 40;

/** Compact, AI-prompt-friendly serialization. */
export interface MemoryFocus {
  /** The current user turn, or the meeting/thread being prepared. */
  text?: string;
  /** Names already resolved — attendees, a contact being discussed. */
  entities?: string[];
}

/** Words that carry meaning for matching; short and common ones do not. */
function significantWords(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9'’-]+/).filter((w) => w.length >= 5));
}

/**
 * Rank memories for a prompt. Pinned first; expired context excluded; then
 * relevance to what the user is doing right now; then recency.
 *
 * Until 2026-09-25 this was newest-first with a hard cap of 40, so a
 * preference saved in month one silently dropped out by month six, and a
 * time-bound "context" note never aged. Exported so the policy is testable.
 */
export function rankForPrompt(items: Memory[], focus?: MemoryFocus, now = Date.now()): Memory[] {
  const words = significantWords(focus?.text ?? "");
  const entities = (focus?.entities ?? []).map((e) => e.toLowerCase()).filter(Boolean);
  const text = (focus?.text ?? "").toLowerCase();
  const score = (m: Memory): number => {
    let s = 0;
    if (m.pinned) s += 100;
    const entity = m.entity?.toLowerCase();
    if (entity && (entities.includes(entity) || (text && text.includes(entity)))) s += 3;
    if (words.size) {
      let overlap = 0;
      for (const w of significantWords(m.content)) if (words.has(w)) overlap += 1;
      s += Math.min(3, overlap);
    }
    return s;
  };
  return items
    .filter((m) => !isExpired(m, now))
    .map((m) => ({ m, s: score(m) }))
    .sort((a, b) => b.s - a.s || new Date(b.m.updatedAt).getTime() - new Date(a.m.updatedAt).getTime())
    .map((x) => x.m);
}

export async function memoriesForPrompt(username: string, focus?: MemoryFocus): Promise<string> {
  const items = rankForPrompt(await listMemories(username), focus);
  if (items.length === 0) return "";

  const byKind: Record<MemoryKind, Memory[]> = {
    preference: [],
    fact: [],
    person: [],
    context: [],
  };

  // Fill each bucket up to per-kind cap, stopping when the total cap is reached.
  // Pinned memories are ranked first, so they are the last to be cut.
  let total = 0;
  for (const m of items) {
    if (total >= PROMPT_MAX_TOTAL) break;
    const bucket = byKind[m.kind];
    if (bucket.length < PROMPT_MAX_PER_KIND) {
      bucket.push(m);
      total++;
    }
  }

  const sections: string[] = [];
  if (byKind.preference.length) {
    sections.push(
      "Preferences:\n" +
        byKind.preference.map((m) => `- ${m.content}`).join("\n")
    );
  }
  if (byKind.context.length) {
    sections.push(
      "Active Context:\n" +
        byKind.context.map((m) => `- ${m.content}`).join("\n")
    );
  }
  if (byKind.person.length) {
    sections.push(
      "Notes on People:\n" +
        byKind.person
          .map((m) => `- ${m.entity ? `${m.entity}: ` : ""}${m.content}`)
          .join("\n")
    );
  }
  if (byKind.fact.length) {
    sections.push(
      "Facts:\n" + byKind.fact.map((m) => `- ${m.content}`).join("\n")
    );
  }

  return sections.join("\n\n");
}
