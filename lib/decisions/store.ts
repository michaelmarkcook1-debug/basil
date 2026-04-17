import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Decision } from "@/lib/types/decision";
import { withLock } from "@/lib/events/lock";

// ── Server-only file-based store ──
// Mirrors lib/memory/store.ts. Decisions persist in .data/ so Basil can read
// and mutate the same list the UI shows.

const DATA_DIR = path.join(process.cwd(), ".data");
const DECISIONS_FILE = path.join(DATA_DIR, "sage-decisions.json");
const LOCK_KEY = "decisions";

async function ensureFile(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DECISIONS_FILE);
  } catch {
    await fs.writeFile(DECISIONS_FILE, "[]", "utf8");
  }
}

async function readAll(): Promise<Decision[]> {
  await ensureFile();
  try {
    const raw = await fs.readFile(DECISIONS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeAll(items: Decision[]): Promise<void> {
  await ensureFile();
  await fs.writeFile(DECISIONS_FILE, JSON.stringify(items, null, 2), "utf8");
}

export async function listDecisions(): Promise<Decision[]> {
  const items = await readAll();
  // Newest date first
  return items.sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );
}

export interface CreateDecisionInput {
  text: string;
  decidedBy: string;
  decidedById?: string;
  date?: string;
  context?: string;
}

export async function createDecision(input: CreateDecisionInput): Promise<Decision> {
  return withLock(LOCK_KEY, async () => {
    const items = await readAll();
    const now = new Date().toISOString();
    const decision: Decision = {
      id: `dec-${randomUUID().slice(0, 8)}`,
      text: input.text.trim(),
      decidedBy: input.decidedBy.trim(),
      decidedById: input.decidedById,
      date: input.date || now.slice(0, 10),
      context: input.context?.trim() || "",
      status: "active",
      createdAt: now,
    };
    items.unshift(decision);
    await writeAll(items);
    return decision;
  });
}

export async function updateDecision(
  id: string,
  patch: Partial<Pick<Decision, "text" | "decidedBy" | "decidedById" | "date" | "context" | "status">>
): Promise<Decision | null> {
  return withLock(LOCK_KEY, async () => {
    const items = await readAll();
    const idx = items.findIndex((d) => d.id === id);
    if (idx === -1) return null;
    items[idx] = { ...items[idx], ...patch };
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
      items.sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
      );
      await writeAll(items);
    }
    return added;
  });
}
