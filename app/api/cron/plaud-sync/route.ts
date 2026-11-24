/** GET /api/cron/plaud-sync — daily (vercel.json): new Plaud recordings → Basil, for every user who connected Plaud. */
import { NextResponse } from "next/server";
import { getUsers } from "@/lib/users";
import { isPlaudConnected } from "@/lib/plaud/oauth";
import { syncPlaud } from "@/lib/plaud/sync";
import { captureCronFailures } from "@/lib/observability/capture";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) return new NextResponse("Forbidden", { status: 403 });
  const results: Record<string, unknown> = {};
  for (const user of await getUsers()) {
    if (user.disabled) continue;
    try {
      if (!(await isPlaudConnected(user.username))) continue;
      const r = await syncPlaud(user.username);
      results[user.username] = { ok: r.failed === 0, ...r };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[cron/plaud-sync] ${user.username}: ${msg}`);
      results[user.username] = { ok: false, error: msg };
    }
  }
  await captureCronFailures("plaud-sync", results);
  const failed = Object.values(results).filter((r) => !(r as { ok?: boolean }).ok).length;
  return NextResponse.json({ ok: failed === 0, users: Object.keys(results).length, failed, results });
}
