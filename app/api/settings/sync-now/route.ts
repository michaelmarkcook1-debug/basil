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
import { selfOrigin } from "@/lib/http/origin";
import { after } from "next/server";
import { google } from "googleapis";
import { randomUUID } from "node:crypto";
import { getSessionUser } from "@/lib/auth";
import { getRecentSlackMessages, getSlackConfig } from "@/lib/slack/client";
import { getAuthedClient } from "@/lib/google/auth";
import { updateCalendar, getWatchState } from "@/lib/google/watch-state";
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
        // Trigger poll-ingest for THIS user. poll-ingest authorises
        // server-to-server callers with CRON_SECRET and scopes the run to the
        // X-Basil-Username header — WITHOUT it, poll-ingest falls back to the
        // admin/first user and would ingest for the wrong account (so "Sync now"
        // would never refresh the logged-in user's data).
        const secret = process.env.CRON_SECRET;
        if (!secret) {
          console.warn("[sync-now] CRON_SECRET unset — cannot trigger ingest");
          return;
        }
        const host = process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : "http://localhost:3000";
        const res = await fetch(`${host}/api/events/poll-ingest`, {
          method: "POST",
          headers: { authorization: `Bearer ${secret}`, "x-basil-username": username },
        });
        console.log(`[sync-now] poll-ingest triggered for ${username}: ${res.status}`);
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
          // Don't leak a fresh channel on every Sync now. If a healthy watch
          // already exists (>24h from expiry), keep it. Otherwise stop the old
          // channel before registering a new one so channels don't accumulate.
          const existing = (await getWatchState(username).catch(() => null))?.calendar; // ci-ok: absent watch-state → treat as no existing channel
          const DAY_MS = 24 * 60 * 60 * 1000;
          if (existing?.channelId && existing.expiration && existing.expiration > Date.now() + DAY_MS) {
            results.calendar = {
              ok: true,
              reason: "already-registered",
              expiresAt: new Date(existing.expiration).toISOString(),
            };
          } else {
          if (existing?.channelId && existing.resourceId) {
            await cal.channels.stop({
              requestBody: { id: existing.channelId, resourceId: existing.resourceId },
            }).catch(() => {/* ci-ok: best-effort stop; old channel may already be gone */});
          }
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
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[sync-now] calendar webhook error:", msg);
      results.calendar = { ok: false, error: msg };
    }
  }

  // ── Briefing generation (background, THIS user only) ─────────────────────
  // Targets the per-user worker with x-basil-username — NOT /api/cron/generate-briefing,
  // which fans out to EVERY user (a per-user action must never regenerate everyone's brief).
  if (jobs.includes("briefing")) {
    after(async () => {
      try {
        const secret = process.env.CRON_SECRET;
        if (!secret) {
          console.warn("[sync-now] CRON_SECRET unset — cannot trigger briefing");
          return;
        }
        const host = selfOrigin();
        const res = await fetch(`${host}/api/generate/briefing`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${secret}`,
            "x-basil-username": username,
          },
          body: JSON.stringify({}),
        });
        console.log(`[sync-now] briefing triggered for ${username}: ${res.status}`);
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
