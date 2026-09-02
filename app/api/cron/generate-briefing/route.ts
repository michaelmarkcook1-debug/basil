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
import { selfOrigin } from "@/lib/http/origin";
import { getUsers } from "@/lib/users";
import { checkGlobalBudget } from "@/lib/ai/spend-guard";
import { hasFeature } from "@/lib/billing/paywall";
import { captureCronFailures } from "@/lib/observability/capture";
import { deliverBriefing } from "@/lib/briefing/delivery";
import type { Briefing } from "@/lib/types/briefing";

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

  const host = selfOrigin();

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

      // Write-then-swap: the briefing POST regenerates from scratch and
      // overwrites the cache ONLY after generation succeeds. So we deliberately
      // do NOT pre-DELETE — if generation fails (AI outage, source error), the
      // user keeps yesterday's briefing instead of being left with nothing.
      // x-basil-username makes the worker generate THIS user's briefing (without
      // it, every cron call collapses onto the admin — the core bug this fixes).
      const res = await fetch(`${host}/api/generate/briefing`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cronSecret}`,
          "x-basil-username": user.username,
        },
        body: JSON.stringify({}),
      });

      if (res.ok) {
        const briefing = await res.json() as Briefing;
        // Push it to the user's enabled channels (email / Slack DM) — the brief
        // arrives instead of waiting to be pulled up. Best-effort.
        const delivery = await deliverBriefing(user.username, briefing).catch((err) => {
          console.error(`[cron/generate-briefing] delivery failed for ${user.username}:`, err instanceof Error ? err.message : err);
          return { email: "error", slack: "error" };
        });
        results[user.username] = { ok: true, generatedAt: briefing.generatedAt, delivery };
        console.log(`[cron/generate-briefing] ${user.username}: generated at ${briefing.generatedAt} (email=${delivery.email} slack=${delivery.slack})`);
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

  await captureCronFailures("generate-briefing", results);

  // Derived, not hardcoded — a run where every user failed must not report
  // success. See lib/http/origin.ts for the week-long outage this concealed.
  const failed = Object.values(results).filter(
    (r) => !(r as { ok?: boolean })?.ok,
  ).length;
  const total = Object.keys(results).length;

  return NextResponse.json({
    ok: failed === 0,
    users: total,
    failed,
    results,
    triggeredAt: new Date().toISOString(),
  }, { status: failed > 0 && failed === total ? 500 : 200 });
}
