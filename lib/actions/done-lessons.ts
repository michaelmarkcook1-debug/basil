/**
 * lib/actions/done-lessons.ts — the "is this done?" judge learns from the
 * items it closed that the user reopened (audit 2026-11-24, item 5).
 *
 * lib/actions/check-done.ts closes an action when the user's sent messages
 * look like it was finished, or its moment has passed. When the user reopens
 * one of those, Basil was wrong. That mistake is kept here (the item, what
 * Basil called it and why) and the newest are shown to the judge as examples
 * not to repeat. The reopened item itself is only judged again on messages
 * sent after the reopen, so the message that fooled it once can't do it twice.
 *
 * One per-user file, done-lessons.json, newest 40.
 */
import "server-only";
import { readUserStore, updateUserStore } from "@/lib/storage/user-store";
import { lastCloseReason, type DoneLesson } from "@/lib/actions/done-lessons-shape";

export type { DoneLesson } from "@/lib/actions/done-lessons-shape";
export { lessonsBlock, lastCloseReason } from "@/lib/actions/done-lessons-shape";

const FILE = "done-lessons.json";
const MAX = 40;

interface Store { v: 1; lessons: DoneLesson[] }
const EMPTY: Store = { v: 1, lessons: [] };

/** Record that Basil closed this wrongly. Never throws to the caller. */
export async function recordDoneMistake(username: string, a: { id: string; text: string; archivedReason?: string; notes?: string; source?: string }): Promise<void> {
  const closedAs: DoneLesson["closedAs"] = a.archivedReason === "expired" ? "expired" : "done";
  const lesson: DoneLesson = { actionId: a.id, text: a.text.slice(0, 300), closedAs, reason: lastCloseReason(a.notes) ?? "", source: a.source, reopenedAt: new Date().toISOString() };
  await updateUserStore<Store>(username, FILE, (cur) => ({
    v: 1,
    lessons: [lesson, ...(cur?.lessons ?? []).filter((l) => l.actionId !== a.id)].slice(0, MAX),
  }), EMPTY, { allowShrink: true });
  console.log(`[check-done] ${username}: reopened an item Basil closed as ${closedAs} — kept as a lesson`);
}

export async function readDoneLessons(username: string): Promise<DoneLesson[]> {
  const s = await readUserStore<Store>(username, FILE, EMPTY, { fresh: true });
  return s?.lessons ?? [];
}
