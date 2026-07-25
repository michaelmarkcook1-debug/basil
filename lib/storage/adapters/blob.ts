/**
 * Vercel Blob storage adapter.
 *
 * Each logical "file" becomes a blob at path:
 *   basil/<scope>/<filename>   (e.g. basil/users/michael/sage-memory.json)
 *   basil/<filename>           (e.g. basil/users.json)
 *
 * Blobs are stored with access: 'private' and addRandomSuffix: false so that
 * the URL is deterministic and overwrites are handled by the Blob service
 * (last write wins). The URL is cached in memory to avoid list() round-trips
 * on warm instances.
 *
 * Reads are authenticated server-side via Authorization: Bearer <BLOB_READ_WRITE_TOKEN>.
 */

import { put, list, del } from "@vercel/blob";

// Namespace prefix so all Basil blobs are grouped together
const PREFIX = "basil";

// ── In-memory URL cache ─────────────────────────────────────────────────────
// Maps blobPathname → URL. Populated by put() and list() results.
// Lives as long as the function instance — avoids redundant list() calls on
// warm instances. Safe to lose on cold start (will re-discover via list).
const urlCache = new Map<string, string>();

// ── Helpers ─────────────────────────────────────────────────────────────────

function blobPathname(scope: string, key: string): string {
  return scope ? `${PREFIX}/${scope}/${key}` : `${PREFIX}/${key}`;
}

/** Server-side authenticated fetch for private blobs. */
async function fetchBlob(url: string): Promise<Response> {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  return fetch(`${url}?v=${Date.now()}`, {
    cache: "no-store",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

/** Resolve the URL for a blob pathname, using cache or list(). */
async function resolveUrl(pathname: string): Promise<string | null> {
  const cached = urlCache.get(pathname);
  if (cached) return cached;

  // list() with a prefix that exactly matches the file (+ trailing / guard)
  const { blobs } = await list({ prefix: pathname, limit: 10 });
  // list() returns prefix-matches, so filter to exact pathname
  const match = blobs.find((b) => b.pathname === pathname);
  if (!match) return null;

  urlCache.set(pathname, match.url);
  return match.url;
}

// ── Public adapter functions ─────────────────────────────────────────────────

/**
 * Thrown when a blob read fails for a reason OTHER than the blob being missing
 * (network error, 5xx, 403, corrupt JSON). Callers doing a read-modify-write
 * MUST let this propagate — coercing it to an empty fallback and then writing
 * would durably wipe the user's real data.
 */
export class BlobReadError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "BlobReadError";
  }
}

/** Thrown when a write would collapse a substantial collection to empty. */
export class BlobShrinkGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlobShrinkGuardError";
  }
}

export async function blobReadJson<T>(
  scope: string,
  key: string,
  fallback: T
): Promise<T> {
  const pathname = blobPathname(scope, key);

  let url: string | null;
  try {
    url = await resolveUrl(pathname);
  } catch (err) {
    // list() failing is a transient service error, NOT "missing" — never coerce
    // to the empty fallback or a read-modify-write could overwrite real data.
    throw new BlobReadError(`blob list failed for ${pathname}`, err);
  }
  if (!url) return fallback; // genuinely absent → empty fallback is correct

  let res: Response;
  try {
    res = await fetchBlob(url);
  } catch (err) {
    throw new BlobReadError(`blob fetch threw for ${pathname}`, err);
  }
  if (res.status === 404) return fallback; // raced deletion → treat as missing
  if (!res.ok) {
    throw new BlobReadError(`blob fetch ${res.status} for ${pathname}`);
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch (err) {
    // The blob EXISTS but its JSON is corrupt/partial. Throwing preserves it;
    // returning empty here would let the next write overwrite it with nothing.
    throw new BlobReadError(`blob JSON parse failed for ${pathname}`, err);
  }

  // Preserve fallback type semantics: array fallback expects array result
  return (
    Array.isArray(fallback) ? (Array.isArray(data) ? data : fallback) : data
  ) as T;
}

/** Item count for shrink-guard purposes; null = not a guarded shape (scalar/string). */
function countItems(data: unknown): number | null {
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === "object") return Object.keys(data).length;
  return null;
}

/** Minimum prior item count that makes an empty overwrite "suspicious". 0 disables. */
const SHRINK_GUARD_MIN = Number.parseInt(process.env.BLOB_SHRINK_GUARD_MIN ?? "5", 10);

export async function blobWriteJson<T>(
  scope: string,
  key: string,
  data: T,
  opts?: { allowShrink?: boolean }
): Promise<void> {
  const pathname = blobPathname(scope, key);

  // Shrink tripwire — backstop against the "failed read → wrote []" wipe.
  // Only engages when the NEW value is empty; the common (non-empty) write path
  // pays zero extra cost. An intentional bulk-clear passes { allowShrink: true }.
  if (!opts?.allowShrink && SHRINK_GUARD_MIN > 0 && countItems(data) === 0) {
    let oldCount: number | null;
    try {
      const existing = await blobReadJson<unknown>(scope, key, null);
      oldCount = countItems(existing);
    } catch (err) {
      // Can't verify prior contents → fail SAFE: refuse the empty overwrite.
      console.error(`[blob] shrink-guard: refusing empty overwrite of ${pathname} — prior read failed:`, err instanceof Error ? err.message : err);
      throw new BlobShrinkGuardError(`Refusing empty overwrite of ${pathname}: could not verify prior contents.`);
    }
    if (oldCount !== null && oldCount >= SHRINK_GUARD_MIN) {
      console.error(`[blob] shrink-guard: refusing to overwrite ${pathname} (${oldCount} items) with empty.`);
      throw new BlobShrinkGuardError(
        `Refusing to overwrite ${pathname} (${oldCount} items) with an empty value. ` +
        `Pass { allowShrink: true } if this clear is intentional.`
      );
    }
  }

  const blob = await put(pathname, JSON.stringify(data), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
  });
  urlCache.set(pathname, blob.url);
}

export async function blobDeleteJson(
  scope: string,
  key: string
): Promise<void> {
  const pathname = blobPathname(scope, key);
  const url = await resolveUrl(pathname);
  if (url) {
    await del(url);
    urlCache.delete(pathname);
  }
}

export async function blobListJson(scope: string): Promise<string[]> {
  const scopePrefix = scope
    ? `${PREFIX}/${scope}/`
    : `${PREFIX}/`;

  const keys: string[] = [];
  let cursor: string | undefined;

  do {
    const result = await list({ prefix: scopePrefix, cursor, limit: 100 });
    for (const blob of result.blobs) {
      // Extract filename relative to scope prefix
      const rel = blob.pathname.slice(scopePrefix.length);
      // Only include direct children (not nested sub-paths)
      if (rel && !rel.includes("/")) {
        keys.push(rel);
        urlCache.set(blob.pathname, blob.url);
      }
    }
    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor);

  return keys;
}

/**
 * Migrate all data from a BASIL_DATA base64 snapshot into Vercel Blob.
 * Called once on first cold-start when Blob is configured but snapshot exists.
 * Writes a sentinel blob (basil/_migrated) on completion so this never runs twice.
 */
export async function blobMigrateFromSnapshot(
  snapshot: Record<string, unknown>
): Promise<void> {
  const entries = Object.entries(snapshot);
  console.log(
    `[blob] Migrating ${entries.length} file(s) from BASIL_DATA snapshot to Vercel Blob…`
  );

  await Promise.all(
    entries.map(async ([key, data]) => {
      // key may be "users.json" or "users/michael/sage-memory.json"
      // The scope is everything except the last path component
      const parts = key.split("/");
      const filename = parts.pop()!;
      const scope = parts.join("/");
      await blobWriteJson(scope, filename, data);
    })
  );

  // Write sentinel so migration is never repeated
  await blobWriteJson("", "_migrated", {
    migratedAt: new Date().toISOString(),
    fileCount: entries.length,
  });

  console.log(`[blob] Migration complete — ${entries.length} file(s) written.`);
}

/** Returns true if the migration sentinel blob exists. */
export async function blobIsMigrated(): Promise<boolean> {
  const url = await resolveUrl(`${PREFIX}/_migrated`);
  return url !== null;
}

/**
 * Delete ALL blobs under basil/users/<username>/ — called on account deletion.
 *
 * Paginates through the entire prefix so it handles any number of files.
 * Batch-deletes each page (up to 100 URLs per del() call).
 * Evicts deleted entries from the in-memory URL cache.
 *
 * @returns Number of blobs deleted.
 */
export async function blobPurgeUserData(username: string): Promise<number> {
  // Lowercase first: usernames are case-insensitive, so purge targets the one store.
  const sanitized = username.toLowerCase().replace(/[^a-zA-Z0-9._-]/g, "_");
  const scopePrefix = `${PREFIX}/users/${sanitized}/`;

  let deleted = 0;
  let cursor: string | undefined;

  do {
    const result = await list({ prefix: scopePrefix, cursor, limit: 100 });
    if (result.blobs.length > 0) {
      const urls = result.blobs.map((b) => b.url);
      await del(urls);
      for (const b of result.blobs) {
        urlCache.delete(b.pathname);
      }
      deleted += result.blobs.length;
    }
    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor);

  return deleted;
}

/**
 * Read every stored file under basil/** (scope, key, parsed JSON content) —
 * used ONLY for the one-time Blob→Postgres migration in persistent.ts. Skips
 * the backup tree and the migration sentinels themselves.
 */
export async function blobReadAllRaw(): Promise<Array<{ scope: string; key: string; data: unknown }>> {
  const out: Array<{ scope: string; key: string; data: unknown }> = [];
  let cursor: string | undefined;

  do {
    const result = await list({ prefix: `${PREFIX}/`, cursor, limit: 100 });
    for (const b of result.blobs) {
      const rel = b.pathname.slice(PREFIX.length + 1); // "users/<u>/file.json" or "file.json"
      if (rel.startsWith("_backups/")) continue;
      if (rel === "_migrated" || rel === "_migrated_from_blob") continue;

      const parts = rel.split("/");
      const key = parts.pop()!;
      const scope = parts.join("/");

      try {
        const res = await fetchBlob(b.url);
        if (!res.ok) continue; // skip unreadable entries — non-fatal for a migration copy
        const data = await res.json();
        out.push({ scope, key, data });
      } catch {
        continue; // one bad file must not abort the whole migration
      }
    }
    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor);

  return out;
}
