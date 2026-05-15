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

export async function blobReadJson<T>(
  scope: string,
  key: string,
  fallback: T
): Promise<T> {
  try {
    const pathname = blobPathname(scope, key);
    const url = await resolveUrl(pathname);
    if (!url) return fallback;

    const res = await fetchBlob(url);
    if (!res.ok) return fallback;

    const data = await res.json();
    // Preserve fallback type semantics: array fallback expects array result
    return (
      Array.isArray(fallback) ? (Array.isArray(data) ? data : fallback) : data
    ) as T;
  } catch {
    return fallback;
  }
}

export async function blobWriteJson<T>(
  scope: string,
  key: string,
  data: T
): Promise<void> {
  const pathname = blobPathname(scope, key);
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
