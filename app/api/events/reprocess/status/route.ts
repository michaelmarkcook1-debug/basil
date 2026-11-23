/** GET /api/events/reprocess/status — how far "Re-process recent events" has got. */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { readReprocessStatus } from "@/lib/events/reprocess-status";

export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  return NextResponse.json({ status: await readReprocessStatus(username) });
}
