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

export function isBackupConfigured(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

/**
 * Copy every blob under basil/** (EXCEPT the backup tree) into
 * basil/_backups/<dateKey>/**. This deliberately includes the account database
 * (secure-users.json), reset tokens, and any other top-level scope — NOT just
 * per-user data — because a clobber of secure-users.json is the highest-impact
 * loss and previously had no recovery point.
 *
 * NOTE: Blob-only. When DATABASE_URL is set the live data lives in Postgres and
 * this Blob snapshot may be stale/empty; rely on the database's own PITR/backups
 * for that backend. dateKey is an ISO date string (YYYY-MM-DD).
 */
export async function backupAllUsers(dateKey: string): Promise<{ copied: number; backupPrefix: string }> {
  const backupPrefix = `${BACKUP_ROOT}/${dateKey}/`;
  let copied = 0;
  let cursor: string | undefined;

  do {
    const result = await list({ prefix: `${PREFIX}/`, cursor, limit: 100 });
    for (const b of result.blobs) {
      // Never back up the backup tree itself — that would grow snapshots
      // geometrically and re-copy yesterday's copies into today's.
      if (b.pathname.startsWith(`${BACKUP_ROOT}/`)) continue;
      // basil/<...> → basil/_backups/<date>/<...>  (e.g. secure-users.json, users/<u>/file.json)
      const rel = b.pathname.slice(PREFIX.length + 1);
      try {
        await copy(b.url, `${backupPrefix}${rel}`, {
          access: "private",
          addRandomSuffix: false,
          allowOverwrite: true,
        });
        copied++;
      } catch (err) {
        // One file failing must not abort the whole backup.
        console.error(`[backup] copy failed for ${b.pathname}:`, err instanceof Error ? err.message : err);
      }
    }
    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor);

  return { copied, backupPrefix };
}

/**
 * Delete backup snapshots whose date folder is strictly older than cutoffKey
 * (an ISO YYYY-MM-DD string). Lexicographic comparison is valid for ISO dates.
 * Returns the number of blobs deleted.
 */
export async function pruneBackups(cutoffKey: string): Promise<number> {
  let deleted = 0;
  let cursor: string | undefined;

  do {
    const result = await list({ prefix: `${BACKUP_ROOT}/`, cursor, limit: 1000 });
    const stale = result.blobs.filter((b) => {
      const m = b.pathname.match(/_backups\/(\d{4}-\d{2}-\d{2})\//);
      return m ? m[1] < cutoffKey : false;
    });
    if (stale.length > 0) {
      await del(stale.map((b) => b.url));
      deleted += stale.length;
    }
    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor);

  return deleted;
}
