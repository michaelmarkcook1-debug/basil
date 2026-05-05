import { randomUUID } from "node:crypto";
import type { Memory, MemoryKind } from "./types";
import { withLock } from "@/lib/events/lock";
import { readUserStore, writeUserStore } from "@/lib/storage/user-store";

const MEMORY_FILE = "sage-memory.json";

// Lock key is per-user so concurrent writes from different users don't block each other
function lockKey(username: string) {
  return `memory:${username}`;
}

async function readAll(username: string): Promise<Memory[]> {
  return readUserStore<Memory[]>(username, MEMORY_FILE, []);
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
    const items = await readAll(username);
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
  const before = await readAll(username);
  const existingIds = new Set(before.map((m) => m.id));
  const item = await createMemory(username, input);
  return { item, created: !existingIds.has(item.id) };
}

export async function updateMemory(
  username: string,
  id: string,
  patch: Partial<Pick<Memory, "content" | "kind" | "entity">>
): Promise<Memory | null> {
  return withLock(lockKey(username), async () => {
    const items = await readAll(username);
    const idx = items.findIndex((m) => m.id === id);
    if (idx === -1) return null;
    items[idx] = {
      ...items[idx],
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await writeAll(username, items);
    return items[idx];
  });
}

export async function deleteMemory(username: string, id: string): Promise<boolean> {
  return withLock(lockKey(username), async () => {
    const items = await readAll(username);
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
export async function memoriesForPrompt(username: string): Promise<string> {
  const items = await listMemories(username); // already newest-first
  if (items.length === 0) return "";

  const byKind: Record<MemoryKind, Memory[]> = {
    preference: [],
    fact: [],
    person: [],
    context: [],
  };

  // Fill each bucket up to per-kind cap, stopping when the total cap is reached.
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
