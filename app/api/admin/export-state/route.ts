/**
 * GET /api/admin/export-state?secret=<ADMIN_EXPORT_SECRET>
 *
 * Returns all .json files from DATA_DIR as a JSON object — the same shape
 * as the BASIL_DATA snapshot. Use this to capture live /tmp state before a
 * redeployment that would trigger a cold start.
 *
 * Protected by ADMIN_EXPORT_SECRET env var (or the query param fallback
 * defined below for one-time use).
 */
import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/storage/paths";
import { readStore } from "@/lib/storage/persistent";

const ONE_TIME_SECRET = "basil-export-2026-04-24";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const secret = searchParams.get("secret") ?? "";
  const expected = process.env.ADMIN_EXPORT_SECRET ?? ONE_TIME_SECRET;

  if (secret !== expected) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Trigger maybeRestore() so BASIL_DATA is hydrated into /tmp on cold start
  await readStore("__ping__.json", null);

  let files: string[] = [];
  try {
    files = await fs.readdir(DATA_DIR);
  } catch {
    return NextResponse.json({ files: {}, note: "DATA_DIR empty or missing — cold start?" });
  }

  const snapshot: Record<string, unknown> = {};
  for (const f of files.filter((f) => f.endsWith(".json"))) {
    try {
      const raw = await fs.readFile(path.join(DATA_DIR, f), "utf8");
      snapshot[f] = JSON.parse(raw);
    } catch {
      // skip unreadable
    }
  }

  return NextResponse.json({
    files: Object.keys(snapshot),
    snapshot,
    basil_data_b64: Buffer.from(JSON.stringify(snapshot)).toString("base64"),
  });
}
