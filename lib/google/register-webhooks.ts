/**
 * lib/google/register-webhooks.ts
 *
 * Shared registration helpers for Gmail push and Calendar watch.
 * Called from:
 *   - POST /api/webhooks/gmail/register
 *   - POST /api/webhooks/calendar/register
 *   - GET  /api/auth/google/callback  (auto-register on connect)
 *   - POST /api/cron/renew-subscriptions
 */

import { google } from "googleapis";
import { randomUUID } from "node:crypto";
import { getAuthedClient } from "@/lib/google/auth";
import { updateGmail, updateCalendar } from "@/lib/google/watch-state";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface GmailRegisterResult {
  ok: true;
  historyId: string | null | undefined;
  watchedEmail: string | undefined;
  expiresAt: string | null;
}

export interface CalendarRegisterResult {
  ok: true;
  channelId: string;
  resourceId: string | null | undefined;
  expiresAt: string | null;
}

// ── Gmail ──────────────────────────────────────────────────────────────────────

/**
 * Register or renew a Gmail Pub/Sub push subscription for `username`.
 * Requires GMAIL_PUBSUB_TOPIC env var.
 * Throws on misconfiguration or API failure.
 */
export async function registerGmailPush(username: string): Promise<GmailRegisterResult> {
  const topic = process.env.GMAIL_PUBSUB_TOPIC;
  if (!topic) throw new Error("GMAIL_PUBSUB_TOPIC not configured");

  const auth = await getAuthedClient(username);
  if (!auth) throw new Error("Google not connected for user");

  const gmail = google.gmail({ version: "v1", auth });

  const profile = await gmail.users.getProfile({ userId: "me" });
  const watchedEmail = profile.data.emailAddress || undefined;

  const res = await gmail.users.watch({
    userId: "me",
    requestBody: {
      topicName: topic,
      labelIds: ["INBOX"],
      labelFilterBehavior: "INCLUDE",
    },
  });

  const { historyId, expiration } = res.data;
  await updateGmail(username, {
    historyId: historyId || undefined,
    expiration: expiration ? Number(expiration) : undefined,
    watchedEmail,
  });

  return {
    ok: true,
    historyId,
    watchedEmail,
    expiresAt: expiration ? new Date(Number(expiration)).toISOString() : null,
  };
}

// ── Calendar ───────────────────────────────────────────────────────────────────

/**
 * Register or renew a Google Calendar webhook watch for `username`.
 * Requires CALENDAR_WATCH_URL and CALENDAR_WATCH_TOKEN env vars.
 * Throws on misconfiguration or API failure.
 */
export async function registerCalendarWatch(username: string): Promise<CalendarRegisterResult> {
  const watchUrl = process.env.CALENDAR_WATCH_URL;
  const watchToken = process.env.CALENDAR_WATCH_TOKEN;
  if (!watchUrl || !watchToken) {
    throw new Error("CALENDAR_WATCH_URL and CALENDAR_WATCH_TOKEN required");
  }

  const auth = await getAuthedClient(username);
  if (!auth) throw new Error("Google not connected for user");

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

  return {
    ok: true,
    channelId,
    resourceId: res.data.resourceId,
    expiresAt: res.data.expiration
      ? new Date(Number(res.data.expiration)).toISOString()
      : null,
  };
}

// ── Combined ───────────────────────────────────────────────────────────────────

/**
 * Auto-register both Gmail push and Calendar watch for `username`.
 * Runs both in parallel. Logs errors but does not throw — safe to call
 * fire-and-forget from the OAuth callback.
 *
 * Returns a summary of what succeeded / failed.
 */
export async function autoRegisterGoogleWebhooks(
  username: string
): Promise<{ gmail: "ok" | "skipped" | "error"; calendar: "ok" | "skipped" | "error" }> {
  const [gmailResult, calResult] = await Promise.allSettled([
    registerGmailPush(username),
    registerCalendarWatch(username),
  ]);

  const gmailStatus =
    gmailResult.status === "fulfilled"
      ? "ok"
      : gmailResult.reason?.message?.includes("not configured") ||
        gmailResult.reason?.message?.includes("not connected")
      ? "skipped"
      : "error";

  const calStatus =
    calResult.status === "fulfilled"
      ? "ok"
      : calResult.reason?.message?.includes("required") ||
        calResult.reason?.message?.includes("not connected")
      ? "skipped"
      : "error";

  if (gmailResult.status === "rejected" && gmailStatus === "error") {
    console.error(
      "[auto-register] Gmail push failed:",
      gmailResult.reason instanceof Error ? gmailResult.reason.message : gmailResult.reason
    );
  }
  if (calResult.status === "rejected" && calStatus === "error") {
    console.error(
      "[auto-register] Calendar watch failed:",
      calResult.reason instanceof Error ? calResult.reason.message : calResult.reason
    );
  }

  if (gmailResult.status === "fulfilled") {
    console.log(
      `[auto-register] Gmail push registered for ${username} — watchedEmail: ${gmailResult.value.watchedEmail}, expires: ${gmailResult.value.expiresAt}`
    );
  }
  if (calResult.status === "fulfilled") {
    console.log(
      `[auto-register] Calendar watch registered for ${username} — channelId: ${calResult.value.channelId}, expires: ${calResult.value.expiresAt}`
    );
  }

  return { gmail: gmailStatus, calendar: calStatus };
}
