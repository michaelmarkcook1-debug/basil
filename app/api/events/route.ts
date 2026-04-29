import { NextResponse } from "next/server";
import { listActiveEvents, listEvents } from "@/lib/events/store";
import { getSessionUser } from "@/lib/auth";

/**
 * GET /api/events?all=1
 *   Default: returns what Basil is actively watching (pending drafts + unacked notifies).
 *   ?all=1  → full history including auto-executed and acknowledged.
 */
export async function GET(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const { searchParams } = new URL(req.url);
  const wantAll = searchParams.get("all") === "1";
  const events = wantAll ? await listEvents() : await listActiveEvents();
  return NextResponse.json({ events });
}
