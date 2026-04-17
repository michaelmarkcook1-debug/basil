import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ActionItem } from "@/lib/types/action";
import { withLock } from "@/lib/events/lock";

// ── Server-only file-based store ──
// Mirrors lib/memory/store.ts. Actions persist in .data/ across dev restarts so
// Basil (running server-side) can see and mutate the same list the UI shows.

const DATA_DIR = path.join(process.cwd(), ".data");
const ACTIONS_FILE = path.join(DATA_DIR, "sage-actions.json");
const LOCK_KEY = "actions";

async function ensureFile(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(ACTIONS_FILE);
  } catch {
    await fs.writeFile(ACTIONS_FILE, "[]", "utf8");
  }
}

async function readAll(): Promise<ActionItem[]> {
  await ensureFile();
  try {
    const raw = await fs.readFile(ACTIONS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeAll(items: ActionItem[]): Promise<void> {
  await ensureFile();
  await fs.writeFile(ACTIONS_FILE, JSON.stringify(items, null, 2), "utf8");
}

function today(): string {
  return new Date().toISOString().split("T")[0];
}

/** Read, auto-marking past-due open items as overdue. */
export async function listActions(): Promise<ActionItem[]> {
  const items = await readAll();
  const t = today();
  const patched = items.map((a) =>
    a.status === "open" && a.dueDate && a.dueDate < t
      ? { ...a, status: "overdue" as const }
      : a
  );
  // Newest first
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
}

export async function createAction(input: CreateActionInput): Promise<ActionItem> {
  return withLock(LOCK_KEY, async () => {
    const items = await readAll();
    const now = new Date().toISOString();
    const action: ActionItem = {
      id: `act-${randomUUID().slice(0, 8)}`,
      text: input.text.trim(),
      owner: (input.owner || "Michael Cook").trim(),
      ownerId: input.ownerId,
      dueDate: input.dueDate,
      status: "open",
      source: input.source ?? "manual",
      createdAt: now,
      updatedAt: now,
    };
    items.unshift(action);
    await writeAll(items);
    return action;
  });
}

export async function updateAction(
  id: string,
  patch: Partial<Pick<ActionItem, "text" | "owner" | "ownerId" | "dueDate" | "status" | "source">>
): Promise<ActionItem | null> {
  return withLock(LOCK_KEY, async () => {
    const items = await readAll();
    const idx = items.findIndex((a) => a.id === id);
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

export async function deleteAction(id: string): Promise<boolean> {
  return withLock(LOCK_KEY, async () => {
    const items = await readAll();
    const next = items.filter((a) => a.id !== id);
    if (next.length === items.length) return false;
    await writeAll(next);
    return true;
  });
}

/** Bulk import — used to migrate any existing localStorage data on first load. */
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
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      await writeAll(items);
    }
    return added;
  });
}
