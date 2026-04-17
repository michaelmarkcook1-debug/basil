import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Memory, MemoryKind } from "./types";
import { withLock } from "@/lib/events/lock";

// ── Server-only file-based store ──
// .data/ is already .gitignored (shares the same directory as OAuth tokens).
// Memories persist across dev restarts and deployments via volume if configured;
// suitable for single-user dev + personal production use.

const DATA_DIR = path.join(process.cwd(), ".data");
const MEMORY_FILE = path.join(DATA_DIR, "sage-memory.json");
const LOCK_KEY = "memory";

async function ensureFile(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(MEMORY_FILE);
  } catch {
    await fs.writeFile(MEMORY_FILE, "[]", "utf8");
  }
}

async function readAll(): Promise<Memory[]> {
  await ensureFile();
  try {
    const raw = await fs.readFile(MEMORY_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeAll(items: Memory[]): Promise<void> {
  await ensureFile();
  await fs.writeFile(MEMORY_FILE, JSON.stringify(items, null, 2), "utf8");
}

export async function listMemories(): Promise<Memory[]> {
  const items = await readAll();
  // Newest first
  return items.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export async function getMemoriesForEntity(entity: string): Promise<Memory[]> {
  const items = await readAll();
  const target = entity.toLowerCase();
  return items.filter((m) => m.entity?.toLowerCase() === target);
}

export interface CreateMemoryInput {
  kind: MemoryKind;
  content: string;
  entity?: string;
  source?: Memory["source"];
}

export async function createMemory(input: CreateMemoryInput): Promise<Memory> {
  return withLock(LOCK_KEY, async () => {
    const items = await readAll();
    const now = new Date().toISOString();

    // Dedupe: if an identical content+entity already exists, just bump updatedAt
    const existingIdx = items.findIndex(
      (m) =>
        m.content.trim().toLowerCase() === input.content.trim().toLowerCase() &&
        (m.entity ?? "").toLowerCase() === (input.entity ?? "").toLowerCase()
    );
    if (existingIdx !== -1) {
      items[existingIdx] = { ...items[existingIdx], updatedAt: now };
      await writeAll(items);
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
    };
    items.unshift(memory);
    await writeAll(items);
    return memory;
  });
}

export async function updateMemory(
  id: string,
  patch: Partial<Pick<Memory, "content" | "kind" | "entity">>
): Promise<Memory | null> {
  return withLock(LOCK_KEY, async () => {
    const items = await readAll();
    const idx = items.findIndex((m) => m.id === id);
    if (idx === -1) return null;
    items[idx] = {
      ...items[idx],
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await writeAll(items);
    return items[idx];
  });
}

export async function deleteMemory(id: string): Promise<boolean> {
  return withLock(LOCK_KEY, async () => {
    const items = await readAll();
    const next = items.filter((m) => m.id !== id);
    if (next.length === items.length) return false;
    await writeAll(next);
    return true;
  });
}

/** Compact, AI-prompt-friendly serialization. */
export async function memoriesForPrompt(): Promise<string> {
  const items = await listMemories();
  if (items.length === 0) return "";

  const byKind: Record<MemoryKind, Memory[]> = {
    preference: [],
    fact: [],
    person: [],
    context: [],
  };
  for (const m of items) byKind[m.kind].push(m);

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
