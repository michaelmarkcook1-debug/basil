/**
 * GET /api/cron/pipedrive-sync — daily at 05:30 UTC (vercel.json), before the
 * 06:15 briefing: the one full Pipedrive read a day for every user who has
 * connected it (lib/pipedrive/client). Everything else reads this copy.
 *
 * Then, for every user, the people directory (lib/people) is rebuilt from
 * contacts, that fresh Pipedrive copy, Slack, the calendar, email and meetings.
 */
import { NextResponse } from "next/server";
import { getUsers } from "@/lib/users";
import { isPipedriveConnected, refreshPipedriveSnapshot } from "@/lib/pipedrive/client";
import { captureCronFailures } from "@/lib/observability/capture";
import { rebuildPeopleDirectory } from "@/lib/people/directory-store";
import { getSettings } from "@/lib/settings/store";

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
    let pipedrive: Record<string, unknown> = { ok: true, skipped: "not connected" };
    try {
      if (await isPipedriveConnected(username)) {
        const snap = await refreshPipedriveSnapshot(username);
        pipedrive = snap
          ? { ok: !snap.stale, deals: snap.deals.length, activities: snap.activities.length, notes: snap.notes.length, ...(snap.stale ? { error: "refresh failed; kept the previous copy" } : {}) }
          : { ok: true, skipped: "not connected" };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[cron/pipedrive-sync] ${username}: ${msg}`);
      pipedrive = { ok: false, error: msg };
    }
    let people: Record<string, unknown>;
    try {
      const tz = (await getSettings(username).catch(() => null))?.timezone || "Europe/London"; // ci-ok: no settings → default zone
      const dir = await rebuildPeopleDirectory(username, { tz });
      people = { ok: true, people: dir.people.length, linked: dir.people.filter((p) => p.sources.length > 1).length };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[cron/pipedrive-sync] people directory, ${username}: ${msg}`);
      people = { ok: false, error: msg };
    }
    results[username] = { ok: pipedrive.ok !== false && people.ok !== false, pipedrive, people };
  }
  await captureCronFailures("pipedrive-sync", results);
  const failed = Object.values(results).filter((r) => !(r as { ok?: boolean }).ok).length;
  return NextResponse.json({ ok: failed === 0, users: Object.keys(results).length, failed, results });
}
