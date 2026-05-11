import { readUserStore, writeUserStore } from "@/lib/storage/user-store";
import type { LedgerItem } from "./types";

const LEDGER_FILE = "ledger.json";

export async function getLedger(username: string): Promise<LedgerItem[]> {
  const data = await readUserStore<{ items: LedgerItem[] }>(username, LEDGER_FILE, { items: [] });
  return data?.items ?? [];
}

export async function saveLedgerItem(username: string, item: LedgerItem): Promise<void> {
  const items = await getLedger(username);
  const idx = items.findIndex((i) => i.id === item.id);
  if (idx >= 0) {
    items[idx] = { ...item, updatedAt: new Date().toISOString() };
  } else {
    items.push(item);
  }
  await writeUserStore(username, LEDGER_FILE, { items });
}

export async function deleteLedgerItem(username: string, id: string): Promise<boolean> {
  const items = await getLedger(username);
  const filtered = items.filter((i) => i.id !== id);
  if (filtered.length === items.length) return false;
  await writeUserStore(username, LEDGER_FILE, { items: filtered });
  return true;
}

export async function updateLedgerItem(
  username: string,
  id: string,
  updates: Partial<LedgerItem>
): Promise<LedgerItem | null> {
  const items = await getLedger(username);
  const idx = items.findIndex((i) => i.id === id);
  if (idx < 0) return null;
  items[idx] = { ...items[idx], ...updates, updatedAt: new Date().toISOString() };
  await writeUserStore(username, LEDGER_FILE, { items });
  return items[idx];
}
