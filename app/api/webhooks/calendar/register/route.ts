import { NextResponse } from "next/server";
import { verifySession, getSessionUser } from "@/lib/auth";
import { registerCalendarWatch } from "@/lib/google/register-webhooks";

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

  try {
    const result = await registerCalendarWatch(username);
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("required") || msg.includes("not connected")) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    console.error("[calendar-register] failed:", msg);
    return NextResponse.json({ error: "Registration failed" }, { status: 500 });
  }
}
