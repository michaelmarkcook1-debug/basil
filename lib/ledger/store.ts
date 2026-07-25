import { readUserStore, writeUserStore } from "@/lib/storage/user-store";
import { withLock } from "@/lib/storage/lock";
import type { LedgerItem } from "./types";

const LEDGER_FILE = "ledger.json";

function lockKey(username: string): string {
  return `ledger:${username}`;
}

export async function getLedger(username: string, fresh = false): Promise<LedgerItem[]> {
  const data = await readUserStore<{ items: LedgerItem[] }>(
    username, LEDGER_FILE, { items: [] }, fresh ? { fresh: true } : undefined,
  );
  return data?.items ?? [];
}

// All mutators run under a per-user lock with a fresh read — an unlocked
// read-modify-write here loses concurrent save/update/delete (last write wins).
export async function saveLedgerItem(username: string, item: LedgerItem): Promise<void> {
  await withLock(lockKey(username), async () => {
    const items = await getLedger(username, true);
    const idx = items.findIndex((i) => i.id === item.id);
    if (idx >= 0) {
      items[idx] = { ...item, updatedAt: new Date().toISOString() };
    } else {
      items.push(item);
    }
    await writeUserStore(username, LEDGER_FILE, { items });
  });
}

export async function deleteLedgerItem(username: string, id: string): Promise<boolean> {
  return withLock(lockKey(username), async () => {
    const items = await getLedger(username, true);
    const filtered = items.filter((i) => i.id !== id);
    if (filtered.length === items.length) return false;
    await writeUserStore(username, LEDGER_FILE, { items: filtered });
    return true;
  });
}

export async function updateLedgerItem(
  username: string,
  id: string,
  updates: Partial<LedgerItem>
): Promise<LedgerItem | null> {
  return withLock(lockKey(username), async () => {
    const items = await getLedger(username, true);
    const idx = items.findIndex((i) => i.id === id);
    if (idx < 0) return null;
    items[idx] = { ...items[idx], ...updates, updatedAt: new Date().toISOString() };
    await writeUserStore(username, LEDGER_FILE, { items });
    return items[idx];
  });
}
