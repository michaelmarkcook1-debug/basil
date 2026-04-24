/**
 * POST /api/admin/force-flush?secret=<secret>
 *
 * Explicitly persists the current /tmp state to BASIL_DATA.
 * Use this after reconnecting integrations to make sure tokens survive
 * the next cold start.
 */
import { NextResponse } from "next/server";
import { readStore, forceFlushSnapshot } from "@/lib/storage/persistent";

const ONE_TIME_SECRET = "basil-flush-2026-04-24";

export async function POST(req: Request) {
  const { searchParams } = new URL(req.url);
  const secret = searchParams.get("secret") ?? "";
  const expected = process.env.ADMIN_EXPORT_SECRET ?? ONE_TIME_SECRET;

  if (secret !== expected) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Trigger maybeRestore so /tmp is populated from BASIL_DATA on cold start
  await readStore("__ping__.json", null);

  const before = Date.now();
  await forceFlushSnapshot();
  const ms = Date.now() - before;

  return NextResponse.json({ ok: true, flushMs: ms });
}
