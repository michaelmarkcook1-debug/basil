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
import { getWorkCalendar } from "@/lib/away/store";
import { awayStatus, dayIn } from "@/lib/away/calendar";
import { notifyUser } from "@/lib/notify";
import { briefingTeaser } from "@/lib/notify/rules";

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
      // A disabled account gets nothing written and nothing emailed.
      if (user.disabled) {
        results[user.username] = { ok: true, skipped: "disabled" };
        continue;
      }
      // Paywall: only generate daily briefings for users whose plan includes
      // them (Pro / trial / admin). Free users are skipped — no unattended spend.
      if (!(await hasFeature(user.username, "briefings"))) {
        results[user.username] = { ok: false, skipped: "not-entitled" };
        continue;
      }

      // No briefing on a day the user is not working: leave, weekends, bank
      // holidays. Until 2026-11-10 it was written and emailed every day of the
      // year, including through a two-week honeymoon. The first working day
      // back gets a briefing that covers the whole gap (see the briefing route).
      // If the working calendar cannot be read, write the briefing as before.
      const cal = await getWorkCalendar(user.username, { refresh: "always" }).catch((e) => {
        console.warn(`[cron/generate-briefing] ${user.username}: working calendar unreadable, briefing anyway:`, e instanceof Error ? e.message : e);
        return null;
      });
      const status = cal ? awayStatus(dayIn(Date.now(), cal.timezone), cal) : null;
      if (status?.state === "away" || status?.state === "non-working") {
        const skipped = status.state === "away" ? "away" : status.reason;
        results[user.username] = { ok: true, skipped, ...(status.state === "away" ? { returnDay: status.returnDay } : {}) };
        console.log(`[cron/generate-briefing] ${user.username}: no briefing today (${skipped})`);
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
        // The model's answer could not be parsed: the route returns the raw
        // text (uncached) for the page to label. Never email, Slack or push it.
        if (briefing.unparsed) {
          results[user.username] = { ok: false, error: "briefing could not be parsed — not delivered" };
          console.error(`[cron/generate-briefing] ${user.username}: unparsed briefing, delivery skipped`);
          continue;
        }
        // Push it to the user's enabled channels (email / Slack DM) — the brief
        // arrives instead of waiting to be pulled up. Best-effort.
        const delivery = await deliverBriefing(user.username, briefing).catch((err) => {
          console.error(`[cron/generate-briefing] delivery failed for ${user.username}:`, err instanceof Error ? err.message : err);
          return { email: "error", slack: "error" };
        });
        // A push to the user's devices, if they turned it on (lib/notify). Once a day.
        const pushed = await notifyUser(user.username, {
          kind: "briefing",
          title: status?.state === "back" ? "Welcome back. Your catch-up briefing is ready" : "Your briefing is ready",
          body: briefingTeaser(briefing),
          url: "/dashboard",
          tag: "basil-briefing",
        }, { onceKeys: [`briefing:${dayIn(Date.now(), cal?.timezone ?? "Europe/London")}`] }).catch((err) => {
          console.warn(`[cron/generate-briefing] push failed for ${user.username}:`, err instanceof Error ? err.message : err);
          return null;
        });
        results[user.username] = { ok: true, generatedAt: briefing.generatedAt, delivery, pushed: pushed?.pushed ?? 0 };
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
