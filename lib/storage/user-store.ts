/**
 * User-scoped storage helpers.
 *
 * Wraps readStore / writeStore with a per-user subdirectory so that each
 * user's data lives at  DATA_DIR/users/<username>/<filename>  and never
 * bleeds into another user's files.
 *
 * Usage:
 *   import { readUserStore, writeUserStore } from "@/lib/storage/user-store";
 *   const events = await readUserStore(username, "sage-events.json", []);
 *   await writeUserStore(username, "sage-events.json", events);
 */

import { readStore, writeStore, updateStore } from "./persistent";

function userSubdir(username: string): string {
  // Sanitise to prevent path traversal — only allow alphanumeric, dash, underscore, dot
  const safe = username.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `users/${safe}`;
}

export async function readUserStore<T>(
  username: string,
  filename: string,
  fallback: T,
  options?: { fresh?: boolean }
): Promise<T> {
  return readStore<T>(filename, fallback, userSubdir(username), options);
}

export async function writeUserStore<T>(
  username: string,
  filename: string,
  data: T
): Promise<void> {
  // All user-scoped writes use strong durability: the Blob write is awaited
  // before returning so that no user-mutating API response is sent before the
  // data is durably persisted.
  return writeStore<T>(filename, data, userSubdir(username), { durability: "strong" });
}

/**
 * Atomic read-modify-write of a per-user file under a cross-instance lock.
 *
 * Use this for any mutation of a user-scoped collection (actions, events,
 * contacts, …) so a cron run that overlaps an interactive request can't clobber
 * the result — e.g. a completed action "resurrecting" because two writers read
 * the same array and the older one wrote last. The mutator gets the FRESH value
 * read inside the lock and returns the next value.
 */
export async function updateUserStore<T>(
  username: string,
  filename: string,
  mutator: (current: T) => T,
  fallback: T,
  options?: { allowShrink?: boolean }
): Promise<T> {
  return updateStore<T>(filename, mutator, fallback, userSubdir(username), options);
}
