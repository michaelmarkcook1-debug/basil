import { NextRequest, NextResponse } from "next/server";
import { getStatus, readPersistedStatus } from "@/lib/whatsapp/dump-job";
import type { DumpStatus } from "@/lib/whatsapp/dump-job";
import { getSessionUser } from "@/lib/auth";

/**
 * GET /api/whatsapp/dump/status?jobId=<uuid>
 *
 * UI polls every second for QR + progress.
 *
 * On Vercel, multiple function instances may be running concurrently.
 * The actual dump runs on the instance that received the POST — polls may
 * land on a *different* instance whose in-memory bag shows "idle".
 *
 * Resolution order:
 *   1. This instance ran the job (memStatus.state !== "idle") → authoritative
 *   2. Persisted file status from any prior write → apply expiry, return
 *   3. Both idle → return idle
 *
 * jobId guard: if ?jobId= is supplied and the current/persisted status
 * belongs to a different job, return the status anyway — the client uses
 * jobId only for stale-instance filtering, not for 404/410.
 */
export async function GET(req: NextRequest) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const requestedJobId = new URL(req.url).searchParams.get("jobId") ?? undefined;

  const memStatus: DumpStatus = getStatus(username); // applies in-memory expiry

  // This instance ran the job — in-memory status is authoritative.
  if (memStatus.state !== "idle") {
    const mismatch = requestedJobId && memStatus.jobId && memStatus.jobId !== requestedJobId;
    return NextResponse.json({
      status: memStatus,
      jobMismatch: !!mismatch,
    });
  }

  // This instance didn't run the job. Check the durable file status.
  const fileStatus = await readPersistedStatus(username); // applies file-level expiry

  // Cancelled jobs should show as idle on the next page visit — don't expose
  // "cancelled" to the poller; the poller already stopped on cancel.
  if (fileStatus && fileStatus.state === "cancelled") {
    const idle: DumpStatus = { state: "idle", chatCount: 0, messageCount: 0, contactCount: 0 };
    return NextResponse.json({ status: idle });
  }

  if (fileStatus && fileStatus.state !== "idle") {
    const mismatch = requestedJobId && fileStatus.jobId && fileStatus.jobId !== requestedJobId;
    return NextResponse.json({
      status: fileStatus,
      jobMismatch: !!mismatch,
    });
  }

  // Both in-memory and file are idle — no job is running.
  return NextResponse.json({ status: memStatus });
}
