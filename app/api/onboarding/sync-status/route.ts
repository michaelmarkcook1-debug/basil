import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isSyncing } from "@/lib/onboarding/sync-status";

export const dynamic = "force-dynamic";

/**
 * GET /api/onboarding/sync-status
 * { syncing: boolean } — true while a day-0 backfill is in flight for the user.
 * Drives the dashboard's "first sync in progress" banner.
 */
export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ syncing: false });
  return NextResponse.json({ syncing: await isSyncing(username) });
}
