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

  // TODO: iterate over all registered users once multi-user is fully live
  const cronUsername = process.env.WEBHOOK_USERNAME ?? "michael";
  const auth = await getAuthedClient(cronUsername);
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

  // ── Microsoft 365: renew mail + calendar subscriptions if expiring within 2 days ──
  const msToken = await getAccessToken(cronUsername);
  if (msToken) {
    const msState = await getMsWatchState();
    const threeDaysMs = 3 * 86400_000;
    const threeDaysFromNow = new Date(Date.now() + threeDaysMs).toISOString();
    const clientState = process.env.MICROSOFT_WEBHOOK_SECRET || randomUUID();

    // MS mail subscription
    const msMailExpiring =
      !msState.mail?.expirationDateTime ||
      new Date(msState.mail.expirationDateTime).getTime() - now < twoDays;

    if (msMailExpiring && process.env.MICROSOFT_MAIL_WEBHOOK_URL) {
      try {
        const res = await graphFetch(cronUsername, "https://graph.microsoft.com/v1.0/subscriptions", {
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
          await updateMsMail({
            subscriptionId: data.id ?? "",
            expirationDateTime: data.expirationDateTime ?? threeDaysFromNow,
            resource: "/me/mailFolders/inbox/messages",
            clientState,
          });
          report.microsoftMail = { renewed: true, expiresAt: data.expirationDateTime };
        } else {
          const body = res ? await res.text() : "no response";
          report.microsoftMail = { renewed: false, error: body };
          console.error("[renew-subscriptions] Microsoft mail subscription failed:", body);
        }
      } catch (e) {
        report.microsoftMail = { error: e instanceof Error ? e.message : String(e) };
        console.error("[renew-subscriptions] Microsoft mail subscription error:", e);
      }
    } else {
      report.microsoftMail = { renewed: false, reason: msMailExpiring ? "no webhook URL" : "not expiring" };
    }

    // MS calendar subscription
    const msCalExpiring =
      !msState.calendar?.expirationDateTime ||
      new Date(msState.calendar.expirationDateTime).getTime() - now < twoDays;

    if (msCalExpiring && process.env.MICROSOFT_CALENDAR_WEBHOOK_URL) {
      try {
        const res = await graphFetch(cronUsername, "https://graph.microsoft.com/v1.0/subscriptions", {
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
          await updateMsCalendar({
            subscriptionId: data.id ?? "",
            expirationDateTime: data.expirationDateTime ?? threeDaysFromNow,
            resource: "/me/events",
            clientState,
          });
          report.microsoftCalendar = { renewed: true, expiresAt: data.expirationDateTime };
        } else {
          const body = res ? await res.text() : "no response";
          report.microsoftCalendar = { renewed: false, error: body };
          console.error("[renew-subscriptions] Microsoft calendar subscription failed:", body);
        }
      } catch (e) {
        report.microsoftCalendar = { error: e instanceof Error ? e.message : String(e) };
        console.error("[renew-subscriptions] Microsoft calendar subscription error:", e);
      }
    } else {
      report.microsoftCalendar = { renewed: false, reason: msCalExpiring ? "no webhook URL" : "not expiring" };
    }
  } else {
    report.microsoftMail     = { renewed: false, reason: "microsoft not connected" };
    report.microsoftCalendar = { renewed: false, reason: "microsoft not connected" };
  }

  return NextResponse.json({ ok: true, report });
}
