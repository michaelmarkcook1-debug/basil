import { NextResponse } from "next/server";
import { google, calendar_v3 } from "googleapis";
import { getAuthedClient } from "@/lib/google/auth";
import { createEvent } from "@/lib/events/store";
import { eventFromIngest } from "@/lib/events/rules";
import { publish } from "@/lib/events/bus";
import { getWatchState, updateCalendar } from "@/lib/google/watch-state";

/**
 * POST /api/webhooks/calendar — Google Calendar push notifications.
 *
 * Google sends a tiny "something changed" ping — no event data. We then call
 * `events.list(syncToken=…)` to fetch the delta and classify each change.
 *
 * Headers Google sends:
 *  - X-Goog-Channel-Id, X-Goog-Resource-Id, X-Goog-Resource-State,
 *    X-Goog-Channel-Token (our shared secret).
 *
 * Channel expires at ~30 days. Cron re-registers via /register.
 */
export async function POST(req: Request) {
  const expectedToken = process.env.CALENDAR_WATCH_TOKEN;
  const sentToken = req.headers.get("x-goog-channel-token");
  if (expectedToken && sentToken !== expectedToken) {
    return new NextResponse("forbidden", { status: 403 });
  }

  const resourceState = req.headers.get("x-goog-resource-state");
  // "sync" is the initial handshake — ignore, nothing to diff yet.
  if (resourceState === "sync") {
    return NextResponse.json({ ok: true, bootstrap: true });
  }

  const auth = await getAuthedClient();
  if (!auth) return NextResponse.json({ ok: true, note: "calendar not connected" });
  const cal = google.calendar({ version: "v3", auth });

  const state = await getWatchState();
  let syncToken = state.calendar?.syncToken;

  try {
    // If we have no syncToken, seed one — we can only act from next push onward.
    if (!syncToken) {
      const seed = await cal.events.list({
        calendarId: "primary",
        maxResults: 1,
      });
      if (seed.data.nextSyncToken) {
        await updateCalendar({ syncToken: seed.data.nextSyncToken });
      }
      return NextResponse.json({ ok: true, seeded: true });
    }

    const res = await cal.events.list({
      calendarId: "primary",
      syncToken,
      maxResults: 50,
    });

    for (const e of res.data.items || []) {
      handleCalendarChange(e);
    }

    if (res.data.nextSyncToken) {
      await updateCalendar({ syncToken: res.data.nextSyncToken });
    }
    return NextResponse.json({
      ok: true,
      processed: (res.data.items || []).length,
    });
  } catch (e) {
    // 410 GONE → token invalid, need to re-seed.
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Calendar events.list error:", msg);
    if (msg.includes("410") || msg.toLowerCase().includes("sync token")) {
      await updateCalendar({ syncToken: undefined });
    }
    return NextResponse.json({ ok: true, error: msg });
  }
}

async function handleCalendarChange(ev: calendar_v3.Schema$Event) {
  const summary = ev.summary || "(untitled)";
  const status = ev.status || "confirmed";
  const organizer = ev.organizer?.displayName || ev.organizer?.email || "";
  const body =
    status === "cancelled"
      ? `Cancelled: ${summary}`
      : `${summary} · ${ev.start?.dateTime || ev.start?.date || "unknown time"}`;

  const shaped = eventFromIngest({
    source: "calendar",
    title: status === "cancelled" ? `Cancelled: ${summary}` : summary,
    body,
    from: organizer,
  });
  const created = await createEvent(shaped);
  publish(created);
}
