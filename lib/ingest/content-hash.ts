/**
 * Stable content hash for ingest idempotency.
 *
 * Used to detect whether the raw source content of a message/event has changed
 * since it was last processed. If the hash is unchanged, we skip the AI
 * classification call and return the existing extracted items.
 *
 * Hash covers the lowercased, trimmed concatenation of the key source fields
 * (subject + body for emails, text for Slack/Teams, title + body for meetings).
 * This means: identical reposts or webhook retries → same hash → no duplicate work.
 */
import { createHash } from "node:crypto";

/**
 * Returns a 16-char hex content hash (64 bits).
 * Normalises whitespace and case before hashing so minor formatting differences
 * (e.g. trailing newlines, HTML whitespace collapse) don't produce new hashes.
 */
export function hashContent(...parts: (string | undefined | null)[]): string {
  const canonical = parts
    .map((p) => (p ?? "").trim().toLowerCase())
    .join("\x00"); // null byte separator avoids collision between adjacent fields
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
