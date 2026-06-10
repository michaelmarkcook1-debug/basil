import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getWorkspaceUsers, isLinearConnected } from "@/lib/linear/client";

/**
 * GET /api/linear/users
 *
 * Returns the active workspace members so the dashboard can render an
 * assignee picker on issue create / edit.
 */
export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  if (!(await isLinearConnected(username))) {
    return NextResponse.json({ users: [], connected: false });
  }

  try {
    const users = await getWorkspaceUsers(username);
    return NextResponse.json({ users, connected: true });
  } catch (e) {
    console.error("[linear/users] failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Failed to load users" }, { status: 502 });
  }
}
