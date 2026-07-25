import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { listStore, readStore } from "@/lib/storage/persistent";

export const dynamic = "force-dynamic";

/**
 * GET /api/profile/export
 *
 * Downloads ALL of the current user's stored data as a single JSON file.
 * Serves two purposes:
 *   - GDPR data portability (right to export).
 *   - Self-serve recovery — a user can keep their own copy, and support can
 *     restore from it if a write ever corrupts a store.
 *
 * Best-effort per file: a single unreadable store is recorded as an error entry
 * rather than failing the whole export.
 */
export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const subdir = `users/${username.toLowerCase().replace(/[^a-zA-Z0-9._-]/g, "_")}`;

  let files: string[] = [];
  try {
    files = await listStore(subdir);
  } catch (err) {
    console.error(`[profile/export] list failed for ${username}:`, err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not list your data — please try again." }, { status: 500 });
  }

  const data: Record<string, unknown> = {};
  for (const file of files) {
    try {
      data[file] = await readStore<unknown>(file, null, subdir);
    } catch (err) {
      data[file] = { __exportError: err instanceof Error ? err.message : String(err) };
    }
  }

  const exportedAt = new Date().toISOString();
  const payload = JSON.stringify({ username, exportedAt, fileCount: files.length, files: data }, null, 2);

  console.info(`[profile/export] user=${username} files=${files.length}`);
  return new NextResponse(payload, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="basil-export-${username}-${exportedAt.slice(0, 10)}.json"`,
      "cache-control": "no-store",
    },
  });
}
