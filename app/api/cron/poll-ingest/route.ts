/**
 * GET /api/cron/poll-ingest
 *
 * Vercel cron wrapper — fans out ingestion across ALL registered users by
 * sending one POST to /api/events/poll-ingest per user with the
 * X-Basil-Username header.
 *
 * Why a wrapper instead of having poll-ingest loop internally?
 *   poll-ingest is a large, stateful handler (~800 lines) designed to process
 *   one user per call.  Running it once per user in sequence here:
 *     a) Keeps each ingest call within Vercel's per-function timeout budget.
 *     b) Lets us add per-user error isolation — one failing user never blocks
 *        the rest.
 *     c) Avoids refactoring the ingest handler just to add a loop.
 *
 * Schedule (vercel.json):  45 5 * * *  (5:45 UTC daily)
 *
 * Sprint 2 — item #9: fan out ingest cron per-user.
 * Previously poll-ingest was listed as the cron path but exported only POST
 * (Vercel crons send GET), so it never ran at all. This wrapper fixes both
 * problems.
 */

import { NextResponse } from "next/server";
import { getUsers } from "@/lib/users";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const host =
    process.env.APP_URL ??
    (process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "http://localhost:3000");

  const users = await getUsers();
  // Skip disabled accounts — no point ingesting for users who cannot log in.
  const activeUsers = users.filter((u) => !u.disabled);

  const results: Record<string, unknown> = {};

  for (const user of activeUsers) {
    try {
      const res = await fetch(`${host}/api/events/poll-ingest`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${cronSecret}`,
          "x-basil-username": user.username,
        },
      });

      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>;
        results[user.username] = { ok: true, ingested: data.ingested ?? data.total ?? "?" };
        console.log(`[cron/poll-ingest] ${user.username}: ok`);
      } else {
        const text = await res.text();
        results[user.username] = { ok: false, status: res.status, error: text.slice(0, 200) };
        console.error(`[cron/poll-ingest] ${user.username}: HTTP ${res.status} — ${text.slice(0, 200)}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results[user.username] = { ok: false, error: msg };
      console.error(`[cron/poll-ingest] ${user.username}: error — ${msg}`);
    }
  }

  return NextResponse.json({
    ok: true,
    users: activeUsers.length,
    results,
    triggeredAt: new Date().toISOString(),
  });
}
