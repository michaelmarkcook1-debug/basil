import { NextResponse } from "next/server";
import { google } from "googleapis";
import { randomUUID } from "node:crypto";
import { getAuthedClient } from "@/lib/google/auth";
import { updateCalendar } from "@/lib/google/watch-state";
import { verifySession, getSessionUser } from "@/lib/auth";

/**
 * POST /api/webhooks/calendar/register — create/renew the Calendar watch.
 *
 * Requires env:
 *   CALENDAR_WATCH_URL    — public HTTPS URL of the webhook
 *   CALENDAR_WATCH_TOKEN  — shared secret Google will echo back in X-Goog-Channel-Token
 *
 * The channelId is stored per-user so inbound push notifications can be
 * resolved back to the owning username via resolveCalendarChannelUser().
 *
 * Max TTL ≈ 30 days; cron renews before expiry.
 */
export async function POST() {
  if (!(await verifySession())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const username = await getSessionUser();
  if (!username) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const watchUrl = process.env.CALENDAR_WATCH_URL;
  const watchToken = process.env.CALENDAR_WATCH_TOKEN;
  if (!watchUrl || !watchToken) {
    return NextResponse.json(
      { error: "CALENDAR_WATCH_URL and CALENDAR_WATCH_TOKEN required" },
      { status: 400 }
    );
  }

  const auth = await getAuthedClient(username);
  if (!auth) {
    return NextResponse.json(
      { error: "Calendar not connected" },
      { status: 400 }
    );
  }

  const cal = google.calendar({ version: "v3", auth });
  const channelId = `basil-cal-${randomUUID()}`;

  try {
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

    return NextResponse.json({
      ok: true,
      channelId,
      resourceId: res.data.resourceId,
      expiresAt: res.data.expiration
        ? new Date(Number(res.data.expiration)).toISOString()
        : null,
    });
  } catch (e) {
    console.error("[calendar-register] failed:", e instanceof Error ? e.message : e);
    return NextResponse.json(
      { error: "Registration failed" },
      { status: 500 }
    );
  }
}
