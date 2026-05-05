/**
 * POST /api/admin/force-flush?secret=<secret>
 *
 * Drains all in-flight Blob writes and returns status. With Blob-backed
 * storage, individual writes are already durable — this just flushes the
 * queue and confirms completion.
 */
import { NextResponse } from "next/server";
import { forceFlushSnapshot, getSnapshotDiagnostics } from "@/lib/storage/persistent";

export async function POST(req: Request) {
  const expected = process.env.ADMIN_EXPORT_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: "ADMIN_EXPORT_SECRET is not configured" },
      { status: 503 }
    );
  }

  const { searchParams } = new URL(req.url);
  const secret = searchParams.get("secret") ?? "";

  if (secret !== expected) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const before = Date.now();
  try {
    await forceFlushSnapshot();
  } catch (err) {
    console.error("[force-flush] forceFlushSnapshot error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Flush failed" }, { status: 500 });
  }
  const ms = Date.now() - before;

  const diag = getSnapshotDiagnostics();
  console.log(`[force-flush] Blob write queue drained in ${ms}ms`);
  return NextResponse.json({
    ok: true,
    flushMs: ms,
    snapshot: diag,
    note: "Blob write queue drained. All data is durable in Vercel Blob.",
  });
}
