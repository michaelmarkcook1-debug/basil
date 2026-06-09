/**
 * Admin user management endpoints (all require admin session).
 *
 * PATCH /api/admin/users/[id]   — update disabled flag
 * DELETE /api/admin/users/[id]  — delete user
 */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getUsers, isAdminUser, setUserDisabled, deleteUser, revokeUserSessions } from "@/lib/users";
import { purgeUserData } from "@/lib/storage/persistent";

type Params = { params: Promise<{ id: string }> };

async function requireAdmin(): Promise<string | null> {
  const username = await getSessionUser();
  if (!username || !isAdminUser(username)) return null;
  return username;
}

export async function PATCH(req: Request, { params }: Params) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  const users = await getUsers();
  const target = users.find((u) => u.id === id);
  if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });

  // Prevent admins from disabling / revoking themselves
  if (target.username.toLowerCase() === admin.toLowerCase() && body.action === "disable") {
    return NextResponse.json({ error: "Cannot disable your own account" }, { status: 400 });
  }

  if (body.action === "revoke") {
    await revokeUserSessions(target.username);
    return NextResponse.json({ success: true, action: "revoked" });
  }

  if (body.action === "disable") {
    await setUserDisabled(target.username, true);
    await revokeUserSessions(target.username);
    return NextResponse.json({ success: true, action: "disabled" });
  }

  if (body.action === "enable") {
    await setUserDisabled(target.username, false);
    return NextResponse.json({ success: true, action: "enabled" });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

export async function DELETE(_req: Request, { params }: Params) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const users = await getUsers();
  const target = users.find((u) => u.id === id);
  if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });

  if (target.username.toLowerCase() === admin.toLowerCase()) {
    return NextResponse.json({ error: "Cannot delete your own account" }, { status: 400 });
  }
  if (target.id === "env-admin") {
    return NextResponse.json({ error: "Cannot delete the environment admin account" }, { status: 400 });
  }

  await deleteUser(target.username);

  // Best-effort blob purge — fire-and-forget so a storage error never blocks
  // a successful admin deletion response. Account record is already gone.
  purgeUserData(target.username)
    .then(({ deleted }) => {
      console.info(`[admin/users/delete] data purge complete for ${target.username}: ${deleted} blob(s) removed`);
    })
    .catch((err) => {
      console.error("[admin/users/delete] data purge failed (non-fatal):", err instanceof Error ? err.message : err);
    });

  console.info(`[admin/users/delete] admin=${admin} deleted user=${target.username}`);
  return NextResponse.json({ success: true });
}
