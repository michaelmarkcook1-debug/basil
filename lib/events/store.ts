import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BasilEvent, EventStatus } from "./types";
import { withLock } from "./lock";

const DATA_DIR = path.join(process.cwd(), ".data");
const FILE = path.join(DATA_DIR, "sage-events.json");
const LOCK_KEY = "events";

async function readAll(): Promise<BasilEvent[]> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    return JSON.parse(raw) as BasilEvent[];
  } catch {
    return [];
  }
}

async function writeAll(events: BasilEvent[]) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(events, null, 2), "utf8");
}

export async function listEvents(): Promise<BasilEvent[]> {
  const all = await readAll();
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listPendingEvents(): Promise<BasilEvent[]> {
  const all = await listEvents();
  return all.filter((e) => e.status === "pending");
}

export async function listActiveEvents(): Promise<BasilEvent[]> {
  // Active = what Basil is currently "watching" — pending drafts + unacknowledged notifies
  const all = await listEvents();
  return all.filter(
    (e) => e.status === "pending" || (e.disposition === "notify" && e.status !== "acknowledged")
  );
}

export async function createEvent(
  e: Omit<BasilEvent, "id" | "createdAt" | "updatedAt">
): Promise<BasilEvent> {
  return withLock(LOCK_KEY, async () => {
    const now = new Date().toISOString();
    const event: BasilEvent = { ...e, id: randomUUID(), createdAt: now, updatedAt: now };
    const all = await readAll();
    all.push(event);
    await writeAll(all);
    return event;
  });
}

export async function updateEventStatus(
  id: string,
  status: EventStatus
): Promise<BasilEvent | null> {
  return withLock(LOCK_KEY, async () => {
    const all = await readAll();
    const idx = all.findIndex((e) => e.id === id);
    if (idx === -1) return null;
    all[idx] = { ...all[idx], status, updatedAt: new Date().toISOString() };
    await writeAll(all);
    return all[idx];
  });
}

export async function deleteEvent(id: string): Promise<boolean> {
  return withLock(LOCK_KEY, async () => {
    const all = await readAll();
    const next = all.filter((e) => e.id !== id);
    if (next.length === all.length) return false;
    await writeAll(next);
    return true;
  });
}

/** Replace the entire store — used by the seeding endpoint. */
export async function replaceAll(events: BasilEvent[]): Promise<void> {
  return withLock(LOCK_KEY, async () => writeAll(events));
}

/** Returns true if an event with this externalId already exists in the store. */
export async function hasExternalId(externalId: string): Promise<boolean> {
  const all = await readAll();
  return all.some((e) => e.externalId === externalId);
}
