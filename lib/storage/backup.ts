/**
 * lib/storage/backup.ts — daily snapshot + retention for Vercel Blob user data.
 *
 * Until the Phase 1 Postgres migration, all user data lives as whole-file JSON
 * in Blob with last-write-wins semantics — so a bad write or clobber is
 * permanent. A daily server-side copy of basil/users/** to a timestamped
 * basil/_backups/<YYYY-MM-DD>/ prefix gives a recovery point, and a retention
 * sweep keeps it bounded.
 *
 * Blob-only: no-op when BLOB_READ_WRITE_TOKEN is absent (local dev uses the
 * filesystem and the host machine's own backups).
 *
 * server-only.
 */

import "server-only";
import { list, copy, del } from "@vercel/blob";

const PREFIX = "basil";
const BACKUP_ROOT = `${PREFIX}/_backups`;
/**
 * Uploaded originals (recordings, documents — lib/uploads/paths.ts). Large,
 * immutable, and already turned into text that lives under users/**. Copying
 * them nightly grows the run with every upload until it misses its deadline
 * again; blobPurgeUserData already treats media as outside the backup.
 */
const MEDIA_ROOT = `${PREFIX}/media`;
/** Top-level folders the nightly backup never copies. */
const NOT_BACKED_UP = new Set([BACKUP_ROOT, MEDIA_ROOT]);

export function isBackupConfigured(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

export interface BlobApi {
  list: typeof list;
  copy: typeof copy;
  del: typeof del;
}
const BLOB: BlobApi = { list, copy, del };

/** Append-only immutable events: copied when new, never again. */
const INCREMENTAL = new Set(["spend"]);
const INCREMENTAL_DAYS = 3;
// 8 tripped Blob's rate limit ("Too many requests … try again in 60 seconds")
// and the whole night's backup failed on 2026-11-13.
const COPY_CONCURRENCY = 4;

/** Blob's rate-limit error: BlobServiceRateLimited, or its message. */
export function isRateLimited(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null;
  return e?.name === "BlobServiceRateLimited" || /too many requests/i.test(e?.message ?? "");
}

/**
 * Run a Blob call, waiting out a rate limit (the error's retryAfter, else 30s)
 * up to three times, never past the deadline. Other errors are thrown as before.
 */
export async function withRateLimitRetry<T>(fn: () => Promise<T>, deadline: number, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimited(err) || attempt >= 3) throw err;
      const after = Number((err as { retryAfter?: unknown }).retryAfter);
      const wait = (Number.isFinite(after) && after > 0 ? after : 30) * 1000;
      if (Date.now() + wait >= deadline) throw err;
      console.warn(`[backup] Blob rate limit — waiting ${Math.round(wait / 1000)}s before retrying`);
      await sleep(wait);
    }
  }
}

export interface BackupResult {
  copied: number;
  failed: number;
  /** False when the deadline arrived first — the cron logs it as an error. */
  complete: boolean;
  backupPrefix: string;
}

/**
 * Copy live data into basil/_backups/<dateKey>/.
 *
 * Until 2026-10-09 this listed ALL of basil/ 100 at a time — including
 * basil/_backups/, which sorts first and had grown to 199k copies — then
 * copied every spend event (6,800+) one by one. It hit the 300s limit every
 * night after copying secure-users.json: per-user data (actions, contacts,
 * memory, tokens) was last backed up on 2026-07-04.
 *
 * Now: discover the top-level scopes without listing the backup tree, copy the
 * account database and per-user data FIRST, append-only scopes only for recent
 * events, in parallel, and stop cleanly at the deadline.
 */
export async function backupAllUsers(
  dateKey: string,
  opts: { deadline?: number; now?: number; api?: BlobApi } = {},
): Promise<BackupResult> {
  const api = opts.api ?? BLOB;
  const now = opts.now ?? Date.now(); // decides which spend events are "new"
  const deadline = opts.deadline ?? Date.now() + 270_000; // always the real clock
  const backupPrefix = `${BACKUP_ROOT}/${dateKey}/`;
  const recentCutoff = now - INCREMENTAL_DAYS * 86_400_000;
  let copied = 0, failed = 0;

  const top = await withRateLimitRetry(() => api.list({ prefix: `${PREFIX}/`, mode: "folded", limit: 1000 }), deadline);
  const folders = (top.folders ?? [])
    .map((f) => f.slice(PREFIX.length + 1).replace(/\/$/, ""))
    .filter((name) => !NOT_BACKED_UP.has(`${PREFIX}/${name}`));
  // users/ first (it is what a restore needs), then the rest, incremental scopes last.
  folders.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

  const copyAll = async (blobs: Array<{ url: string; pathname: string }>) => {
    let i = 0;
    await Promise.all(Array.from({ length: COPY_CONCURRENCY }, async () => {
      while (i < blobs.length && Date.now() < deadline) {
        const b = blobs[i++];
        try {
          await withRateLimitRetry(() => api.copy(b.url, backupPrefix + b.pathname.slice(PREFIX.length + 1), {
            access: "private", addRandomSuffix: false, allowOverwrite: true,
          }), deadline);
          copied++;
        } catch (err) {
          failed++;
          console.error(`[backup] copy failed for ${b.pathname}:`, err instanceof Error ? err.message : err);
        }
      }
    }));
    return i >= blobs.length;
  };

  // Top-level files: the account database (secure-users.json) and token stores.
  if (!(await copyAll(top.blobs))) return { copied, failed, complete: false, backupPrefix };

  for (const folder of folders) {
    let cursor: string | undefined;
    do {
      if (Date.now() >= deadline) return { copied, failed, complete: false, backupPrefix };
      const page = await withRateLimitRetry(() => api.list({ prefix: `${PREFIX}/${folder}/`, cursor, limit: 1000 }), deadline);
      const blobs = INCREMENTAL.has(folder)
        ? page.blobs.filter((b) => new Date(b.uploadedAt).getTime() >= recentCutoff)
        : page.blobs;
      if (!(await copyAll(blobs))) return { copied, failed, complete: false, backupPrefix };
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  }
  return { copied, failed, complete: true, backupPrefix };
}

function rank(folder: string): number {
  if (folder === "users") return 0;
  if (INCREMENTAL.has(folder)) return 2;
  return 1;
}

/**
 * Delete snapshot folders dated strictly before cutoffKey, oldest first, until
 * the deadline (a backlog is finished on later nights). Folder names may carry
 * a suffix ("2026-10-09-manual"); the leading date decides.
 */
export async function pruneBackups(
  cutoffKey: string,
  opts: { deadline?: number; api?: BlobApi } = {},
): Promise<{ deleted: number; complete: boolean }> {
  const api = opts.api ?? BLOB;
  const deadline = opts.deadline ?? Date.now() + 120_000;
  let deleted = 0;
  const top = await withRateLimitRetry(() => api.list({ prefix: `${BACKUP_ROOT}/`, mode: "folded", limit: 1000 }), deadline);
  const stale = (top.folders ?? [])
    .map((f) => ({ folder: f, date: f.slice(BACKUP_ROOT.length + 1, BACKUP_ROOT.length + 11) }))
    .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.date) && x.date < cutoffKey)
    .sort((a, b) => a.date.localeCompare(b.date));
  for (const { folder } of stale) {
    let cursor: string | undefined;
    do {
      if (Date.now() >= deadline) return { deleted, complete: false };
      const page = await withRateLimitRetry(() => api.list({ prefix: folder, cursor, limit: 1000 }), deadline);
      for (let k = 0; k < page.blobs.length; k += 500) {
        const chunk = page.blobs.slice(k, k + 500);
        await withRateLimitRetry(() => api.del(chunk.map((b) => b.url)), deadline);
        deleted += chunk.length;
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  }
  return { deleted, complete: true };
}
