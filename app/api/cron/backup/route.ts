/**
 * GET /api/cron/backup
 *
 * Daily snapshot of all user data in Vercel Blob. Copies basil/users/** to a
 * timestamped basil/_backups/<YYYY-MM-DD>/ prefix and prunes snapshots older
 * than BACKUP_RETAIN_DAYS (default 14). A recovery point for the flat-file era
 * until Phase 1 moves mutable data to a real database.
 *
 * Schedule (vercel.json): 30 2 * * *  (02:30 UTC, before the morning crons).
 */

import { NextResponse } from "next/server";
import { isBackupConfigured, backupAllUsers, pruneBackups } from "@/lib/storage/backup";

export const dynamic = "force-dynamic";
// Backing up every user's blobs can take a while on large stores.
export const maxDuration = 300;

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  if (!isBackupConfigured()) {
    // Local / non-Blob deployments rely on host filesystem backups.
    return NextResponse.json({ ok: true, skipped: "blob-not-configured" });
  }

  const todayKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const retainDays = Number.parseInt(process.env.BACKUP_RETAIN_DAYS ?? "14", 10);
  const cutoffKey = new Date(Date.now() - retainDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const started = Date.now();
  try {
    // Leave headroom under maxDuration (300s): back up within 240s, prune only
    // after a COMPLETE backup, in whatever is left before 285s.
    const backup = await backupAllUsers(todayKey, { deadline: started + 240_000 });
    const prune = backup.complete
      ? await pruneBackups(cutoffKey, { deadline: started + 285_000 })
      : { deleted: 0, complete: false };
    const line = `[cron/backup] snapshot ${todayKey}: copied=${backup.copied} failed=${backup.failed} complete=${backup.complete} pruned=${prune.deleted}${prune.complete ? "" : " (prune continues tomorrow)"} (retain ${retainDays}d) in ${Math.round((Date.now() - started) / 1000)}s`;
    if (backup.complete && backup.failed === 0) console.info(line); else console.error(line);
    return NextResponse.json({ ok: backup.complete && backup.failed === 0, date: todayKey, ...backup, pruned: prune.deleted, pruneComplete: prune.complete },
      { status: backup.complete ? 200 : 500 });
  } catch (err) {
    console.error("[cron/backup] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ ok: false, error: "backup failed" }, { status: 500 });
  }
}
