/**
 * PATCH /api/profile/password
 * Change the authenticated user's password.
 * Requires current password verification. Bumps sessionVersion so all
 * existing sessions are invalidated — user must re-login.
 */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { validateCredentials, changePassword } from "@/lib/users";

export async function PATCH(req: Request) {
  const username = await getSessionUser();
  if (!username) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null); // ci-ok: malformed request body returns null, handled below
  const { currentPassword, newPassword } = body ?? {};

  if (!currentPassword || !newPassword) {
    return NextResponse.json({ error: "currentPassword and newPassword are required" }, { status: 400 });
  }

  if (newPassword.length < 8) {
    return NextResponse.json({ error: "New password must be at least 8 characters" }, { status: 400 });
  }

  // Verify current password before allowing change.
  const valid = await validateCredentials(username, currentPassword);
  if (!valid) {
    return NextResponse.json({ error: "Current password is incorrect" }, { status: 403 });
  }

  await changePassword(username, newPassword);

  // Return 200 — client should redirect to login since all sessions are revoked
  return NextResponse.json({ success: true, requiresRelogin: true });
}
