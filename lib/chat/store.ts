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

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  /** Plain-text content only — tool calls are not stored for replay. */
  content: string;
  createdAt: string;
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
    const existing = await readUserStore<StoredMessage[]>(username, HISTORY_FILE, []);
    const merged = [...existing, ...messages];
    // Keep only the most recent N messages
    const trimmed = merged.length > MAX_STORED_MESSAGES
      ? merged.slice(merged.length - MAX_STORED_MESSAGES)
      : merged;
    await writeUserStore(username, HISTORY_FILE, trimmed);
  });
}

export async function clearChatHistory(username: string): Promise<void> {
  await writeUserStore(username, HISTORY_FILE, []);
}
