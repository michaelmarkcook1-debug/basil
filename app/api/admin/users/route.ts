/**
 * GET /api/admin/users
 * Returns all registered users (minus password hashes). Admin-only.
 */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getUsers, isAdminUser, toSafeUser } from "@/lib/users";

export async function GET() {
  const username = await getSessionUser();
  if (!username || !isAdminUser(username)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const users = await getUsers();
  return NextResponse.json({ users: users.map(toSafeUser) });
}
