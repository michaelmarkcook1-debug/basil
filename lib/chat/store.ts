/**
 * Per-user chat history store.
 *
 * Each user's conversation is saved to  DATA_DIR/users/<username>/chat-history.json
 * as an array of plain message objects (role + content). This gives persistent
 * memory across sessions and devices without leaking one user's history to another.
 *
 * We cap stored history at MAX_STORED_MESSAGES (most-recent) to keep the file
 * small and cold-start restore fast.
 */

import { readUserStore, writeUserStore } from "@/lib/storage/user-store";
import { withLock } from "@/lib/events/lock";
import { redactSensitive } from "@/lib/security/sensitive";
import type { StoredToolReceipt as ReceiptShape, StoredMessageShape } from "./receipts";

const HISTORY_FILE = "chat-history.json";
const MAX_STORED_MESSAGES = 200; // keep last 200 messages per user (~100 exchanges)

/** Lightweight record of a tool call within a message — what Basil actually did. */
export type StoredToolReceipt = ReceiptShape;

/** Rows saved before 2026-09-15 have no `outcome`; lib/chat/receipts derives one from `state`. */
export type StoredMessage = Omit<StoredMessageShape, "toolReceipts"> & {
  toolReceipts?: Array<Omit<StoredToolReceipt, "outcome"> & { outcome?: StoredToolReceipt["outcome"] }>;
  /** Set when a later save revised this message (an approval continuation, a denial acknowledgement). */
  revisedAt?: string;
};

function lockKey(username: string) {
  return `chat-history:${username}`;
}

export async function getChatHistory(username: string): Promise<StoredMessage[]> {
  return readUserStore<StoredMessage[]>(username, HISTORY_FILE, []);
}

/**
 * Upsert messages into the user's history (oldest-first).
 *
 * New ids are appended. An id already stored is REVISED in place — content and
 * receipts replaced, original position and createdAt kept. Ids not in the
 * payload are never touched, so a fresh session can only add or revise its own
 * turns; it cannot erase earlier conversations (the PUT-replace data-loss bug
 * this function was first written to end).
 *
 * Revision matters because an approval continuation reuses the assistant
 * message id: the first save archives "approval requested", the save after the
 * user's decision carries the denial and its acknowledgement. Refusing that
 * second save — which this function did until 2026-09-15 — froze every
 * approved or denied action at its pending receipt, and restore then showed
 * it as done.
 *
 * Trims to MAX_STORED_MESSAGES so the file doesn't grow unbounded.
 */
export async function appendChatMessages(
  username: string,
  messages: StoredMessage[]
): Promise<void> {
  if (messages.length === 0) return;
  return withLock(lockKey(username), async () => {
    const existing = await readUserStore<StoredMessage[]>(username, HISTORY_FILE, [], { fresh: true });
    const now = new Date().toISOString();
    const byId = new Map(existing.map((m, i) => [m.id, i] as const));
    const next = [...existing];
    let changed = false;
    for (const incoming of messages) {
      // Persistence never keeps a credential the model may have repeated.
      const m: StoredMessage = { ...incoming, content: redactSensitive(incoming.content ?? "").text };
      const idx = byId.get(m.id);
      if (idx === undefined) {
        byId.set(m.id, next.length);
        next.push(m);
        changed = true;
        continue;
      }
      const prev = next[idx];
      const same = prev.content === m.content && JSON.stringify(prev.toolReceipts ?? []) === JSON.stringify(m.toolReceipts ?? []);
      if (same) continue;
      next[idx] = { ...prev, content: m.content, toolReceipts: m.toolReceipts, revisedAt: now };
      changed = true;
    }
    if (!changed) return;
    const trimmed = next.length > MAX_STORED_MESSAGES ? next.slice(next.length - MAX_STORED_MESSAGES) : next;
    await writeUserStore(username, HISTORY_FILE, trimmed);
  });
}

export async function clearChatHistory(username: string): Promise<void> {
  await writeUserStore(username, HISTORY_FILE, []);
}
