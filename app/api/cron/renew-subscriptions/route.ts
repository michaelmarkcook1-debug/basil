import { NextResponse } from "next/server";
import { google } from "googleapis";
import { randomUUID } from "node:crypto";
import { getAuthedClient } from "@/lib/google/auth";
import {
  getWatchState,
  updateCalendar,
  updateGmail,
} from "@/lib/google/watch-state";
import { graphFetch, getAccessToken } from "@/lib/microsoft/auth";
import {
  getWatchState as getMsWatchState,
  updateMail as updateMsMail,
  updateCalendar as updateMsCalendar,
} from "@/lib/microsoft/watch-state";
import { getUsers } from "@/lib/users";

/**
 * Daily cron — re-registers Gmail and Calendar watch channels before they
 * expire, for every user who has the integration connected.
 *
 * Schedule in vercel.json:
 *   { "crons": [{ "path": "/api/cron/renew-subscriptions", "schedule": "0 4 * * *" }] }
 */
export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}

async function handle(req: Request) {
  const authHeader = req.headers.get("authorization");
  const expected = process.env.CRON_SECRET;
  if (expected && authHeader !== `Bearer ${expected}`) {
    return new NextResponse("forbidden", { status: 403 });
  }

  const users = await getUsers();
  const results: Record<string, unknown> = {};

  for (const user of users) {
    const username = user.username;
    const userReport: Record<string, unknown> = {};

    // ── Google (Gmail + Calendar) ─────────────────────────────────────────
    const auth = await getAuthedClient(username);
    if (auth) {
      const state = await getWatchState(username);
      const now = Date.now();
      const twoDays = 2 * 86400_000;

      // Gmail: renew if expiring within 2 days
      const gmailExpiring =
        !state.gmail?.expiration || state.gmail.expiration - now < twoDays;
      if (gmailExpiring && process.env.GMAIL_PUBSUB_TOPIC) {
        try {
          const gmail = google.gmail({ version: "v1", auth });

          // Refresh watchedEmail on each renewal in case the account changed
          const profile = await gmail.users.getProfile({ userId: "me" }).catch(() => null); // ci-ok: optional profile refresh; watchedEmail fallback handles null
          const watchedEmail = profile?.data.emailAddress || state.gmail?.watchedEmail;

          const res = await gmail.users.watch({
            userId: "me",
            requestBody: {
              topicName: process.env.GMAIL_PUBSUB_TOPIC,
              labelIds: ["INBOX"],
              labelFilterBehavior: "INCLUDE",
            },
          });
          await updateGmail(username, {
            historyId: res.data.historyId || undefined,
            expiration: res.data.expiration ? Number(res.data.expiration) : undefined,
            watchedEmail,
          });
          userReport.gmail = {
            renewed: true,
            expiresAt: res.data.expiration
              ? new Date(Number(res.data.expiration)).toISOString()
              : null,
          };
        } catch (e) {
          userReport.gmail = { error: e instanceof Error ? e.message : String(e) };
          console.error(`[renew-subscriptions] Gmail renewal failed for ${username}:`, e);
        }
      } else {
        userReport.gmail = { renewed: false, reason: gmailExpiring ? "no pubsub topic" : "not expiring" };
      }

      // Calendar: renew if expiring within 2 days
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
          await updateCalendar(username, {
            channelId,
            resourceId: res.data.resourceId || undefined,
            expiration: res.data.expiration ? Number(res.data.expiration) : undefined,
          });
          userReport.calendar = {
            renewed: true,
            expiresAt: res.data.expiration
              ? new Date(Number(res.data.expiration)).toISOString()
              : null,
          };
        } catch (e) {
          userReport.calendar = { error: e instanceof Error ? e.message : String(e) };
          console.error(`[renew-subscriptions] Calendar renewal failed for ${username}:`, e);
        }
      } else {
        userReport.calendar = { renewed: false, reason: calExpiring ? "no watch URL/token" : "not expiring" };
      }
    } else {
      userReport.gmail    = { renewed: false, reason: "google not connected" };
      userReport.calendar = { renewed: false, reason: "google not connected" };
    }

    // ── Microsoft 365 (mail + calendar) ──────────────────────────────────
    const msToken = await getAccessToken(username);
    if (msToken) {
      const msState = await getMsWatchState(username);
      const now = Date.now();
      const twoDays = 2 * 86400_000;
      const threeDaysFromNow = new Date(Date.now() + 3 * 86400_000).toISOString();
      const clientState = process.env.MICROSOFT_WEBHOOK_SECRET || randomUUID();

      // MS mail subscription
      const msMailExpiring =
        !msState.mail?.expirationDateTime ||
        new Date(msState.mail.expirationDateTime).getTime() - now < twoDays;

      if (msMailExpiring && process.env.MICROSOFT_MAIL_WEBHOOK_URL) {
        try {
          const res = await graphFetch(username, "https://graph.microsoft.com/v1.0/subscriptions", {
            method: "POST",
            body: JSON.stringify({
              changeType: "created",
              notificationUrl: process.env.MICROSOFT_MAIL_WEBHOOK_URL,
              resource: "/me/mailFolders/inbox/messages",
              expirationDateTime: threeDaysFromNow,
              clientState,
            }),
          });
          if (res && res.ok) {
            const data = (await res.json()) as { id?: string; expirationDateTime?: string };
            await updateMsMail(username, {
              subscriptionId: data.id ?? "",
              expirationDateTime: data.expirationDateTime ?? threeDaysFromNow,
              resource: "/me/mailFolders/inbox/messages",
              clientState,
            });
            userReport.microsoftMail = { renewed: true, expiresAt: data.expirationDateTime };
          } else {
            const body = res ? await res.text() : "no response";
            userReport.microsoftMail = { renewed: false, error: body };
            console.error(`[renew-subscriptions] MS mail subscription failed for ${username}:`, body);
          }
        } catch (e) {
          userReport.microsoftMail = { error: e instanceof Error ? e.message : String(e) };
          console.error(`[renew-subscriptions] MS mail subscription error for ${username}:`, e);
        }
      } else {
        userReport.microsoftMail = { renewed: false, reason: msMailExpiring ? "no webhook URL" : "not expiring" };
      }

      // MS calendar subscription
      const msCalExpiring =
        !msState.calendar?.expirationDateTime ||
        new Date(msState.calendar.expirationDateTime).getTime() - now < twoDays;

      if (msCalExpiring && process.env.MICROSOFT_CALENDAR_WEBHOOK_URL) {
        try {
          const res = await graphFetch(username, "https://graph.microsoft.com/v1.0/subscriptions", {
            method: "POST",
            body: JSON.stringify({
              changeType: "created,updated",
              notificationUrl: process.env.MICROSOFT_CALENDAR_WEBHOOK_URL,
              resource: "/me/events",
              expirationDateTime: threeDaysFromNow,
              clientState,
            }),
          });
          if (res && res.ok) {
            const data = (await res.json()) as { id?: string; expirationDateTime?: string };
            await updateMsCalendar(username, {
              subscriptionId: data.id ?? "",
              expirationDateTime: data.expirationDateTime ?? threeDaysFromNow,
              resource: "/me/events",
              clientState,
            });
            userReport.microsoftCalendar = { renewed: true, expiresAt: data.expirationDateTime };
          } else {
            const body = res ? await res.text() : "no response";
            userReport.microsoftCalendar = { renewed: false, error: body };
            console.error(`[renew-subscriptions] MS calendar subscription failed for ${username}:`, body);
          }
        } catch (e) {
          userReport.microsoftCalendar = { error: e instanceof Error ? e.message : String(e) };
          console.error(`[renew-subscriptions] MS calendar subscription error for ${username}:`, e);
        }
      } else {
        userReport.microsoftCalendar = { renewed: false, reason: msCalExpiring ? "no webhook URL" : "not expiring" };
      }
    } else {
      userReport.microsoftMail     = { renewed: false, reason: "microsoft not connected" };
      userReport.microsoftCalendar = { renewed: false, reason: "microsoft not connected" };
    }

    results[username] = userReport;
    console.log(`[renew-subscriptions] ${username}:`, JSON.stringify(userReport));
  }

  return NextResponse.json({ ok: true, users: Object.keys(results).length, results });
}
