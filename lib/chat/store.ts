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

const HISTORY_FILE = "chat-history.json";
const MAX_STORED_MESSAGES = 200; // keep last 200 messages per user (~100 exchanges)

/** Lightweight record of a tool call within a message — what Basil actually did. */
export interface StoredToolReceipt {
  toolName: string;
  /** Final state at save time: "output-available" | "output-denied" | etc. */
  state: string;
  /** Tool call arguments — capped by the caller before storage. */
  input?: unknown;
}

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  /** Plain-text content only. */
  content: string;
  createdAt: string;
  /** Tool calls made as part of this message (drafts sent, meetings booked, etc.) — a receipt, not a full replay. */
  toolReceipts?: StoredToolReceipt[];
}

function lockKey(username: string) {
  return `chat-history:${username}`;
}

export async function getChatHistory(username: string): Promise<StoredMessage[]> {
  return readUserStore<StoredMessage[]>(username, HISTORY_FILE, []);
}

/**
 * Append new messages to the user's history (oldest-first).
 * Trims to MAX_STORED_MESSAGES so the file doesn't grow unbounded.
 */
export async function appendChatMessages(
  username: string,
  messages: StoredMessage[]
): Promise<void> {
  if (messages.length === 0) return;
  return withLock(lockKey(username), async () => {
    const existing = await readUserStore<StoredMessage[]>(username, HISTORY_FILE, [], { fresh: true });
    // Idempotent append: skip any message whose id is already stored. This lets
    // the client POST its whole (growing) session every turn without duplicating,
    // and — crucially — means a new turn can only ADD to the archive, never
    // replace it. The old PUT-replace auto-save silently wiped ALL prior
    // conversations whenever a fresh session saved its first exchange.
    const seen = new Set(existing.map((m) => m.id));
    const fresh = messages.filter((m) => !seen.has(m.id));
    if (fresh.length === 0) return;
    const merged = [...existing, ...fresh];
    const trimmed = merged.length > MAX_STORED_MESSAGES
      ? merged.slice(merged.length - MAX_STORED_MESSAGES)
      : merged;
    await writeUserStore(username, HISTORY_FILE, trimmed);
  });
}

export async function clearChatHistory(username: string): Promise<void> {
  await writeUserStore(username, HISTORY_FILE, []);
}
