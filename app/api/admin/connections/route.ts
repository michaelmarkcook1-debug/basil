/**
 * GET  /api/admin/connections — every account's data sources, checked live
 *      where safe (see lib/admin/connections.ts). Admin only.
 * POST /api/admin/connections — re-run the setup that needs no sign-in
 *      (Gmail push + Calendar watch) for every account with working Google.
 */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isAdminUser } from "@/lib/users";
import { checkAllConnections, renewAll } from "@/lib/admin/connections";

export const maxDuration = 60;

async function admin(): Promise<string | null> {
  const username = await getSessionUser();
  return username && isAdminUser(username) ? username : null;
}

export async function GET() {
  const me = await admin();
  if (!me) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const accounts = await checkAllConnections();
  return NextResponse.json({ accounts, me, checkedAt: new Date().toISOString() });
}

export async function POST() {
  if (!(await admin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const renewed = await renewAll();
  console.log(`[admin/connections] renewed: ${renewed.map((r) => `${r.username} gmail=${r.gmail} calendar=${r.calendar}`).join("; ")}`);
  return NextResponse.json({ renewed });
}
