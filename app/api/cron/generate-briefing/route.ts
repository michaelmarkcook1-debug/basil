/**
 * GET /api/cron/generate-briefing
 *
 * Vercel cron endpoint — generates the daily briefing for each user with
 * CRON_SECRET authentication.  Runs after poll-ingest + reprocess so the
 * briefing has fresh, classified signals to work from.
 *
 * Schedule (vercel.json):
 *   0 6 * * *  — 6:15am UTC (7:15am BST) daily
 *
 * This endpoint simply POSTs to /api/generate/briefing on behalf of each
 * user via an internal loopback call.  Briefing generation requires a full
 * HTTP round-trip so the route handler's `maxDuration` limit applies
 * per-user rather than in aggregate.
 */

import { NextResponse } from "next/server";
import { getUsers } from "@/lib/users";
import { checkGlobalBudget } from "@/lib/ai/spend-guard";
import { hasFeature } from "@/lib/billing/paywall";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  // Global spend gate — briefing generation is the most expensive unattended
  // Opus workload and its cost scales with every user. If the global monthly
  // ceiling is already reached, skip the whole fan-out rather than blow past it.
  const budget = await checkGlobalBudget();
  if (!budget.ok) {
    console.warn(`[cron/generate-briefing] global AI budget reached (${budget.scope}) — skipping run`);
    return NextResponse.json({ ok: false, skipped: "global-budget-reached", scope: budget.scope });
  }

  const host = process.env.APP_URL
    ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

  const users = await getUsers();
  const results: Record<string, unknown> = {};

  for (const user of users) {
    try {
      // Paywall: only generate daily briefings for users whose plan includes
      // them (Pro / trial / admin). Free users are skipped — no unattended spend.
      if (!(await hasFeature(user.username, "briefings"))) {
        results[user.username] = { ok: false, skipped: "not-entitled" };
        continue;
      }

      // First delete the stale cache so POST always regenerates
      await fetch(`${host}/api/generate/briefing`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${cronSecret}` },
      });

      const res = await fetch(`${host}/api/generate/briefing`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cronSecret}`,
        },
        body: JSON.stringify({}),
      });

      if (res.ok) {
        const data = await res.json() as { generatedAt?: string };
        results[user.username] = { ok: true, generatedAt: data.generatedAt };
        console.log(`[cron/generate-briefing] ${user.username}: generated at ${data.generatedAt}`);
      } else {
        const text = await res.text();
        results[user.username] = { ok: false, status: res.status, error: text.slice(0, 200) };
        console.error(`[cron/generate-briefing] ${user.username}: HTTP ${res.status} — ${text.slice(0, 200)}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results[user.username] = { ok: false, error: msg };
      console.error(`[cron/generate-briefing] ${user.username}: error — ${msg}`);
    }
  }

  return NextResponse.json({
    ok: true,
    users: Object.keys(results).length,
    results,
    triggeredAt: new Date().toISOString(),
  });
}
