import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { deleteUser, isAdminUser, findByUsername } from "@/lib/users";
import { forceFlushSnapshot } from "@/lib/storage/persistent";
import path from "path";
import fs from "fs/promises";

/**
 * GET /api/profile
 * Returns the current user's username and email (read-only account info).
 */
export async function GET() {
  const username = await getSessionUser();
  if (!username) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const user = await findByUsername(username);
  return NextResponse.json({
    username: user?.username ?? username,
    email: user?.email ?? "",
  });
}

/**
 * DELETE /api/profile
 *
 * Permanently deletes the current user's account and all their stored data.
 * Cannot delete the admin account.
 */
export async function DELETE() {
  const username = await getSessionUser();
  if (!username) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  if (isAdminUser(username)) {
    return NextResponse.json(
      { error: "The admin account cannot be deleted" },
      { status: 403 }
    );
  }

  try {
    // 1. Remove from users.json
    await deleteUser(username);

    // 2. Best-effort: remove legacy filesystem data directory if it exists (no-op on Vercel/Blob).
    const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data"); // ci-ok: legacy local-fs cleanup, harmless on Blob-backed deployments
    const userDir = path.join(DATA_DIR, "users", username.replace(/[^a-zA-Z0-9._-]/g, "_")); // ci-ok: legacy local-fs cleanup
    await fs.rm(userDir, { recursive: true, force: true });

    // 3. Persist deletion so removed user can't reappear on cold start
    await forceFlushSnapshot();

    // 4. Clear the session cookie in the response
    const res = NextResponse.json({ ok: true });
    res.cookies.set("basil_token", "", { path: "/", maxAge: 0 });
    return res;
  } catch (err) {
    console.error("[profile/delete] Error deleting account:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "Failed to delete account" },
      { status: 500 }
    );
  }
}
