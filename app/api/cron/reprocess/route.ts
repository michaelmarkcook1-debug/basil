/**
 * GET /api/cron/reprocess
 *
 * Vercel cron wrapper — fans out the backfill classifier across ALL active
 * users by POSTing to /api/events/reprocess once per user with the
 * X-Basil-Username header. Mirrors /api/cron/poll-ingest.
 *
 * Before this, vercel.json pointed the cron directly at /api/events/reprocess,
 * which (lacking the header) resolved every call to the admin user — so only
 * the admin's events were ever backfilled. This wrapper gives every user their
 * own reprocess pass with per-user error isolation.
 *
 * Schedule (vercel.json): 0 6 * * *  (06:00 UTC, after poll-ingest at 05:45).
 */

import { NextResponse } from "next/server";
import { getUsers } from "@/lib/users";
import { captureCronFailures } from "@/lib/observability/capture";

export const dynamic = "force-dynamic";
// Fans out reprocessing per user sequentially — platform-max budget so the tail
// of the user list isn't silently truncated as accounts grow.
export const maxDuration = 300;

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const host =
    process.env.APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

  const users = await getUsers();
  const activeUsers = users.filter((u) => !u.disabled);
  const results: Record<string, unknown> = {};

  for (const user of activeUsers) {
    try {
      const res = await fetch(`${host}/api/events/reprocess`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${cronSecret}`,
          "x-basil-username": user.username,
        },
      });

      if (res.ok) {
        results[user.username] = { ok: true };
        console.log(`[cron/reprocess] ${user.username}: ok`);
      } else {
        const text = await res.text();
        results[user.username] = { ok: false, status: res.status, error: text.slice(0, 200) };
        console.error(`[cron/reprocess] ${user.username}: HTTP ${res.status} — ${text.slice(0, 200)}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results[user.username] = { ok: false, error: msg };
      console.error(`[cron/reprocess] ${user.username}: error — ${msg}`);
    }
  }

  await captureCronFailures("reprocess", results);

  return NextResponse.json({
    ok: true,
    users: activeUsers.length,
    results,
    triggeredAt: new Date().toISOString(),
  });
}
