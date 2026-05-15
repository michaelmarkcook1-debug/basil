/**
 * POST /api/settings/sync-now
 *
 * Manually triggers data freshness jobs for the authenticated user without
 * waiting for the cron schedule. Runs Slack sync and queues poll-ingest via
 * a background after() task so the response returns quickly.
 *
 * Protected: requires a valid session (not cron-secret) since it runs per-user.
 */
import { NextResponse } from "next/server";
import { after } from "next/server";
import { google } from "googleapis";
import { randomUUID } from "node:crypto";
import { getSessionUser } from "@/lib/auth";
import { getRecentSlackMessages, getSlackConfig } from "@/lib/slack/client";
import { getAuthedClient } from "@/lib/google/auth";
import { updateCalendar } from "@/lib/google/watch-state";
import { readUserStore, writeUserStore } from "@/lib/storage/user-store";
import { HEALTH_META_FILE, type HealthMeta } from "@/lib/system/health";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const body = await req.json().catch(() => ({})) as { jobs?: string[] };
  const jobs = body.jobs ?? ["slack", "ingest", "calendar"];

  const results: Record<string, unknown> = {};

  // ── Slack sync (in-request, fast enough) ─────────────────────────────────
  if (jobs.includes("slack")) {
    try {
      const config = await getSlackConfig(username);
      if (!config.botToken && !config.userToken) {
        results.slack = { ok: false, reason: "not_connected" };
      } else {
        const messages = await getRecentSlackMessages(username, 200, 30);
        const now = new Date().toISOString();
        const existing = await readUserStore<HealthMeta>(username, HEALTH_META_FILE, {});
        await writeUserStore<HealthMeta>(username, HEALTH_META_FILE, {
          ...existing,
          lastSlackSyncAt: now,
        });
        results.slack = { ok: true, messageCount: messages.length, syncedAt: now };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[sync-now] Slack error:", msg);
      results.slack = { ok: false, error: msg };
    }
  }

  // ── Poll-ingest (background — can take 20+ seconds) ──────────────────────
  if (jobs.includes("ingest")) {
    after(async () => {
      try {
        // Call our own poll-ingest cron endpoint internally.
        // We pass the CRON_SECRET so the route accepts the request.
        const secret = process.env.CRON_SECRET;
        const host = process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : "http://localhost:3000";
        const res = await fetch(`${host}/api/events/poll-ingest`, {
          method: "POST",
          headers: secret ? { authorization: `Bearer ${secret}` } : {},
        });
        console.log(`[sync-now] poll-ingest triggered: ${res.status}`);
      } catch (e) {
        console.error("[sync-now] poll-ingest background error:", e instanceof Error ? e.message : e);
      }
    });
    results.ingest = { ok: true, status: "queued_in_background" };
  }

  // ── Calendar webhook registration (inline — avoids internal-fetch auth issues) ──
  if (jobs.includes("calendar")) {
    try {
      const watchUrl   = process.env.CALENDAR_WATCH_URL;
      const watchToken = process.env.CALENDAR_WATCH_TOKEN;
      if (!watchUrl || !watchToken) {
        results.calendar = { ok: false, reason: "CALENDAR_WATCH_URL or CALENDAR_WATCH_TOKEN not configured" };
      } else {
        const auth = await getAuthedClient(username);
        if (!auth) {
          results.calendar = { ok: false, reason: "Google not connected" };
        } else {
          const cal = google.calendar({ version: "v3", auth });
          const channelId = `basil-cal-${randomUUID()}`;
          const res = await cal.events.watch({
            calendarId: "primary",
            requestBody: {
              id: channelId,
              type: "web_hook",
              address: watchUrl,
              token: watchToken,
            },
          });
          await updateCalendar(username, {
            channelId,
            resourceId: res.data.resourceId || undefined,
            expiration: res.data.expiration ? Number(res.data.expiration) : undefined,
          });
          const expiresAt = res.data.expiration
            ? new Date(Number(res.data.expiration)).toISOString()
            : null;
          results.calendar = { ok: true, channelId, expiresAt };
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[sync-now] calendar webhook error:", msg);
      results.calendar = { ok: false, error: msg };
    }
  }

  // ── Briefing generation (background via cron endpoint) ───────────────────
  if (jobs.includes("briefing")) {
    after(async () => {
      try {
        const secret = process.env.CRON_SECRET;
        const host = process.env.APP_URL
          ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");
        const res = await fetch(`${host}/api/cron/generate-briefing`, {
          method: "GET",
          headers: secret ? { authorization: `Bearer ${secret}` } : {},
        });
        console.log(`[sync-now] briefing cron triggered: ${res.status}`);
      } catch (e) {
        console.error("[sync-now] briefing background error:", e instanceof Error ? e.message : e);
      }
    });
    results.briefing = { ok: true, status: "queued_in_background" };
  }

  return NextResponse.json({
    ok: true,
    triggeredAt: new Date().toISOString(),
    results,
  });
}
