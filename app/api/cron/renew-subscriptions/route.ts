import { NextResponse } from "next/server";
import { google } from "googleapis";
import { randomUUID } from "node:crypto";
import { getAuthedClient } from "@/lib/google/auth";
import {
  getWatchState,
  updateCalendar,
  updateGmail,
} from "@/lib/google/watch-state";

/**
 * Daily cron — re-registers Gmail and Calendar watch channels before they expire.
 *
 * Schedule in vercel.json:
 *   { "crons": [{ "path": "/api/cron/renew-subscriptions", "schedule": "0 4 * * *" }] }
 *
 * Vercel Cron includes a Bearer token we verify. Also accepts manual POST.
 */
export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}

async function handle(req: Request) {
  // Vercel Cron auth. The CRON_SECRET env var is set via `vercel env add`.
  const authHeader = req.headers.get("authorization");
  const expected = process.env.CRON_SECRET;
  if (expected && authHeader !== `Bearer ${expected}`) {
    return new NextResponse("forbidden", { status: 403 });
  }

  const auth = getAuthedClient();
  if (!auth) {
    return NextResponse.json({ ok: false, reason: "google not connected" });
  }

  const state = await getWatchState();
  const now = Date.now();
  const twoDays = 2 * 86400_000;

  const report: Record<string, unknown> = {};

  // ── Gmail: renew if expiring within 2 days ──
  const gmailExpiring =
    !state.gmail?.expiration || state.gmail.expiration - now < twoDays;
  if (gmailExpiring && process.env.GMAIL_PUBSUB_TOPIC) {
    try {
      const gmail = google.gmail({ version: "v1", auth });
      const res = await gmail.users.watch({
        userId: "me",
        requestBody: {
          topicName: process.env.GMAIL_PUBSUB_TOPIC,
          labelIds: ["INBOX"],
          labelFilterBehavior: "INCLUDE",
        },
      });
      await updateGmail({
        historyId: res.data.historyId || undefined,
        expiration: res.data.expiration ? Number(res.data.expiration) : undefined,
      });
      report.gmail = {
        renewed: true,
        expiresAt: res.data.expiration
          ? new Date(Number(res.data.expiration)).toISOString()
          : null,
      };
    } catch (e) {
      report.gmail = { error: e instanceof Error ? e.message : String(e) };
    }
  } else {
    report.gmail = { renewed: false, reason: "not expiring" };
  }

  // ── Calendar: renew if expiring within 2 days ──
  const calExpiring =
    !state.calendar?.expiration || state.calendar.expiration - now < twoDays;
  const calUrl = process.env.CALENDAR_WATCH_URL;
  const calToken = process.env.CALENDAR_WATCH_TOKEN;
  if (calExpiring && calUrl && calToken) {
    try {
      const cal = google.calendar({ version: "v3", auth });
      const channelId = `basil-cal-${randomUUID()}`;
      const res = await cal.events.watch({
        calendarId: "primary",
        requestBody: {
          id: channelId,
          type: "web_hook",
          address: calUrl,
          token: calToken,
        },
      });
      await updateCalendar({
        channelId,
        resourceId: res.data.resourceId || undefined,
        expiration: res.data.expiration ? Number(res.data.expiration) : undefined,
      });
      report.calendar = {
        renewed: true,
        expiresAt: res.data.expiration
          ? new Date(Number(res.data.expiration)).toISOString()
          : null,
      };
    } catch (e) {
      report.calendar = { error: e instanceof Error ? e.message : String(e) };
    }
  } else {
    report.calendar = { renewed: false, reason: "not expiring" };
  }

  return NextResponse.json({ ok: true, report });
}
