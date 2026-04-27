/**
 * GET /api/admin/export-state
 *
 * Returns all .json files from DATA_DIR as a JSON object — the same shape
 * as the BASIL_DATA snapshot. Use this to capture live /tmp state before a
 * redeployment that would trigger a cold start.
 *
 * Protected by the session cookie (same auth as the rest of the app).
 * The proxy already enforces auth for all /api routes, but we re-check here
 * as defence-in-depth since this endpoint exports the full data store.
 */
import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/storage/paths";
import { readStore } from "@/lib/storage/persistent";
import { verifySession } from "@/lib/auth";

export async function GET() {
  if (!(await verifySession())) {
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
