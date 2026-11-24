/**
 * GET /api/cron/pipedrive-sync — daily at 05:30 UTC (vercel.json), before the
 * 06:15 briefing: the one full Pipedrive read a day for every user who has
 * connected it (lib/pipedrive/client). Everything else reads this copy.
 */
import { NextResponse } from "next/server";
import { getUsers } from "@/lib/users";
import { isPipedriveConnected, refreshPipedriveSnapshot } from "@/lib/pipedrive/client";
import { captureCronFailures } from "@/lib/observability/capture";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  const results: Record<string, unknown> = {};
  for (const user of await getUsers()) {
    if (user.disabled) continue;
    const username = user.username;
    try {
      if (!(await isPipedriveConnected(username))) continue;
      const snap = await refreshPipedriveSnapshot(username);
      results[username] = snap
        ? { ok: !snap.stale, deals: snap.deals.length, activities: snap.activities.length, notes: snap.notes.length, ...(snap.stale ? { error: "refresh failed; kept the previous copy" } : {}) }
        : { ok: true, skipped: "not connected" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[cron/pipedrive-sync] ${username}: ${msg}`);
      results[username] = { ok: false, error: msg };
    }
  }
  await captureCronFailures("pipedrive-sync", results);
  const failed = Object.values(results).filter((r) => !(r as { ok?: boolean }).ok).length;
  return NextResponse.json({ ok: failed === 0, users: Object.keys(results).length, failed, results });
}
