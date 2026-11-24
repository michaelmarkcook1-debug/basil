/**
 * lib/briefing/history-store.ts — briefing-history.json: the critical and
 * follow-up lines of each morning briefing, 60 days (lib/briefing/history.ts).
 */
import "server-only";
import { readUserStore, updateUserStore } from "@/lib/storage/user-store";
import { itemsOf, withDay, type BriefingDay } from "@/lib/briefing/history";

const FILE = "briefing-history.json";
interface Store { v: 1; days: BriefingDay[] }
const EMPTY: Store = { v: 1, days: [] };

export async function readBriefingHistory(username: string): Promise<BriefingDay[]> {
  const s = await readUserStore<Store>(username, FILE, EMPTY).catch((e) => {
    console.warn("[briefing/history] unreadable:", e instanceof Error ? e.message : e);
    return EMPTY;
  });
  return s?.days ?? [];
}

/** Never throws: a history write must not fail the briefing. */
export async function recordBriefingDay(username: string, day: string, b: { criticalToday?: string | null; followUps?: string | null }): Promise<void> {
  try {
    const items = [...itemsOf(b.criticalToday), ...itemsOf(b.followUps)];
    if (!items.length) return;
    await updateUserStore<Store>(username, FILE, (cur) => ({ v: 1, days: withDay(cur?.days ?? [], day, items) }), EMPTY, { allowShrink: true });
  } catch (e) {
    console.warn("[briefing/history] not recorded:", e instanceof Error ? e.message : e);
  }
}
