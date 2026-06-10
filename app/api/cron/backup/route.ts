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

  try {
    const { copied, backupPrefix } = await backupAllUsers(todayKey);
    const pruned = await pruneBackups(cutoffKey);
    console.info(`[cron/backup] snapshot ${todayKey}: copied=${copied} pruned=${pruned} (retain ${retainDays}d)`);
    return NextResponse.json({ ok: true, date: todayKey, copied, pruned, backupPrefix });
  } catch (err) {
    console.error("[cron/backup] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ ok: false, error: "backup failed" }, { status: 500 });
  }
}
