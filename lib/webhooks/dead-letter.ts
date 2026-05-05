/**
 * Webhook dead-letter store — captures inbound notifications that cannot be
 * resolved to an owning user.
 *
 * Entries are appended to webhook-deadletter.json (root scope, not per-user
 * since we don't know which user they belong to). The file is capped at 200
 * entries to avoid unbounded growth. Each entry carries enough information to
 * replay or investigate the unresolved event.
 */

import { readStore, writeStore } from "@/lib/storage/persistent";

const DEAD_LETTER_FILE = "webhook-deadletter.json";
const MAX_ENTRIES = 200;

export interface DeadLetterEntry {
  ts:      string;  // ISO timestamp
  source:  string;  // e.g. "gmail", "ms-mail", "ms-calendar", "slack", "calendar"
  reason:  string;  // why ownership couldn't be resolved
  payload: unknown; // sanitised excerpt of the inbound payload
}

/**
 * Append an unresolvable webhook notification to the dead-letter store.
 * Fire-and-forget safe — errors are swallowed so the webhook still acks 200.
 */
export async function writeDeadLetter(
  source: string,
  payload: unknown,
  reason: string
): Promise<void> {
  try {
    const entries = await readStore<DeadLetterEntry[]>(DEAD_LETTER_FILE, []);
    const entry: DeadLetterEntry = {
      ts: new Date().toISOString(),
      source,
      reason,
      // Limit payload size to avoid storing large bodies
      payload: safeExcerpt(payload),
    };
    const updated = [...entries, entry].slice(-MAX_ENTRIES);
    await writeStore<DeadLetterEntry[]>(DEAD_LETTER_FILE, updated, undefined, { durability: "strong" });
    console.warn(`[dead-letter] ${source}: ${reason}`);
  } catch (err) {
    console.error("[dead-letter] Failed to write dead-letter entry:", err instanceof Error ? err.message : err);
  }
}

/** Truncate a payload to a safe excerpt to avoid huge JSON blobs in storage. */
function safeExcerpt(payload: unknown): unknown {
  try {
    const str = JSON.stringify(payload);
    if (str.length <= 2048) return payload;
    return { _truncated: true, excerpt: str.slice(0, 2048) };
  } catch {
    return { _unserializable: true };
  }
}
