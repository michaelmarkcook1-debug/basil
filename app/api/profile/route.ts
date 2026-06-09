import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { deleteUser, isAdminUser, findByUsername } from "@/lib/users";
import { forceFlushSnapshot, purgeUserData } from "@/lib/storage/persistent";
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
    // 1. Remove from users.json (account record — must succeed before anything else)
    await deleteUser(username);

    // 2. Persist deletion so removed user can't reappear on cold start
    await forceFlushSnapshot();

    // 3. Purge all blob / filesystem data for this user (best-effort, non-blocking).
    //    We fire-and-forget so a storage error never blocks a successful account
    //    deletion response. The account record is already gone.
    purgeUserData(username)
      .then(({ deleted }) => {
        console.info(`[profile/delete] data purge complete for ${username}: ${deleted} blob(s) removed`);
      })
      .catch((err) => {
        console.error("[profile/delete] data purge failed (non-fatal):", err instanceof Error ? err.message : err);
      });

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
