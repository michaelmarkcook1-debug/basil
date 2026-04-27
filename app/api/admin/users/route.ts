/**
 * GET /api/admin/users
 * Returns all registered users (minus password hashes). Admin-only.
 */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getUsers, isAdminUser } from "@/lib/users";

export async function GET() {
  const username = await getSessionUser();
  if (!username || !isAdminUser(username)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const users = await getUsers();
  const safe = users.map(({ password: _pw, ...rest }) => rest);

  return NextResponse.json({ users: safe });
}
