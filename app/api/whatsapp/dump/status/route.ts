import { NextResponse } from "next/server";
import { getStatus, WHATSAPP_STATUS_FILE } from "@/lib/whatsapp/dump-job";
import { readStore } from "@/lib/storage/persistent";
import type { DumpStatus } from "@/lib/whatsapp/dump-job";

/**
 * GET /api/whatsapp/dump/status — UI polls every second for QR + progress.
 *
 * On Vercel, multiple function instances may be running concurrently.
 * The actual dump runs on the instance that received the POST request —
 * status polls may land on a *different* instance whose in-memory bag
 * shows "idle".  To avoid returning stale-idle, we fall back to the
 * file-persisted status (written by setStatus() in dump-job.ts) which
 * is readable from any instance via the shared /tmp/basil-data dir.
 */
export async function GET() {
  const memStatus = getStatus();

  // This instance ran the job — in-memory status is authoritative.
  if (memStatus.state !== "idle") {
    return NextResponse.json({ status: memStatus });
  }

  // This instance didn't run the job.  Check the persisted file status.
  // readStore() calls maybeRestore() internally so it works after cold starts too.
  let fileStatus: DumpStatus | null = null;
  try {
    fileStatus = await readStore<DumpStatus | null>(WHATSAPP_STATUS_FILE, null);
  } catch (err) {
    console.error("[whatsapp/status] Failed to read persisted status:", err instanceof Error ? err.message : err);
  }

  // Use the file status if it represents an active or recently-completed job.
  // We ignore file status if it's also "idle" — nothing useful there.
  if (fileStatus && fileStatus.state !== "idle") {
    return NextResponse.json({ status: fileStatus });
  }

  // Both in-memory and file are idle — no job is running.
  return NextResponse.json({ status: memStatus });
}
