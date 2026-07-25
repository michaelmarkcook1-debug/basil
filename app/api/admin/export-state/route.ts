/**
 * GET /api/admin/export-state
 *
 * Returns a list of all store files visible from the current instance.
 * With Blob-backed storage this reflects what's in Vercel Blob (via /tmp
 * cache). Useful for debugging; no longer needed for pre-redeployment
 * snapshots since Blob storage is redeployment-safe.
 *
 * Protected by session cookie + admin check.
 */
import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/storage/paths"; // ci-ok: importing the canonical path constant from storage layer
import { listStore } from "@/lib/storage/persistent";
import { verifySession, getSessionUser } from "@/lib/auth";
import { isAdminUser } from "@/lib/users";

export async function GET() {
  if (!(await verifySession())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const username = await getSessionUser();
  if (!username || !isAdminUser(username)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // List root-level and user-scoped files from Blob (or local FS in dev)
  const [rootFiles, userFiles] = await Promise.all([
    listStore(),
    listStore(`users/${username.toLowerCase().replace(/[^a-zA-Z0-9._-]/g, "_")}`),
  ]);

  // Also snapshot /tmp cache for debugging warm-instance state
  async function collectTmp(dir: string, relBase = ""): Promise<string[]> {
    let entries: string[];
    try { entries = await fs.readdir(dir); } catch { return []; }
    const results: string[] = [];
    for (const entry of entries) {
      const absPath = path.join(dir, entry);
      const relPath = relBase ? `${relBase}/${entry}` : entry;
      let isDir = false;
      try { isDir = (await fs.stat(absPath)).isDirectory(); } catch { continue; }
      if (isDir) {
        results.push(...await collectTmp(absPath, relPath));
      } else if (entry.endsWith(".json")) {
        results.push(relPath);
      }
    }
    return results;
  }

  const tmpFiles = await collectTmp(DATA_DIR); // ci-ok: DATA_DIR from lib/storage/paths, legacy export only

  console.log(`[export-state] user=${username} root=${rootFiles.length} userFiles=${userFiles.length} tmp=${tmpFiles.length}`);
  return NextResponse.json({
    storage: process.env.BLOB_READ_WRITE_TOKEN ? "vercel-blob" : "filesystem",
    blobRootFiles: rootFiles,
    blobUserFiles: userFiles,
    tmpCacheFiles: tmpFiles,
    note: "Data is durable in Vercel Blob — no pre-deployment snapshot needed.",
  });
}
