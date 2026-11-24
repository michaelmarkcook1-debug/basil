/**
 * GET /api/cron/premeeting — every 10 minutes (vercel.json).
 *
 * A push about 20 minutes before each meeting with someone from outside the
 * user's company, linking to its prep (audit 2026-11-24, Part 3 entry 12;
 * rules in lib/notify/premeeting-rules.ts). Reads the calendar only for users
 * who could receive it: push configured, a device on, the "Before meetings"
 * choice on, a working day they are not away. No AI is called — the prep is
 * written when the user opens it.
 */
import { NextResponse } from "next/server";
import { getUsers } from "@/lib/users";
import { getSettings } from "@/lib/settings/store";
import { getNotifyState, isPushConfigured, notifyUser } from "@/lib/notify";
import { hourIn } from "@/lib/notify/rules";
import { readCalendar } from "@/lib/calendar/unified";
import { getSelfIdentity } from "@/lib/self-identity";
import { getWorkCalendar } from "@/lib/away/store";
import { awayStatus, dayIn } from "@/lib/away/calendar";
import { meetingsToNudge, nudgeKey, nudgeNotification } from "@/lib/notify/premeeting-rules";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  if (!isPushConfigured()) return NextResponse.json({ ok: true, skipped: "push-not-configured" });

  const now = Date.now();
  const results: Record<string, unknown> = {};
  for (const user of await getUsers()) {
    if (user.disabled) continue;
    const username = user.username;
    try {
      const state = await getNotifyState(username);
      if (!state.prefs.meetings) { results[username] = { skipped: "off" }; continue; }
      if (state.devices.length === 0) { results[username] = { skipped: "no-device" }; continue; }
      const settings = await getSettings(username);
      const tz = settings.timezone || "Europe/London";
      const hour = hourIn(now, tz);
      if (hour < 6 || hour >= 22) { results[username] = { skipped: "night" }; continue; }
      const cal = await getWorkCalendar(username, { refresh: "never" }).catch((e) => {
        console.warn(`[cron/premeeting] ${username}: working calendar unreadable, treating today as working:`, e instanceof Error ? e.message : e);
        return null;
      });
      const st = cal ? awayStatus(dayIn(now, tz), cal).state : "working";
      if (st === "away" || st === "non-working") { results[username] = { skipped: st }; continue; }

      const [calendar, self] = await Promise.all([
        readCalendar(username, { days: 1 }, tz),
        getSelfIdentity(username),
      ]);
      const own = new Set(self.emails.map((e) => e.split("@")[1]?.toLowerCase()).filter((d): d is string => !!d));
      const due = meetingsToNudge(calendar.events, own, now).filter(({ event }) => !state.sent[nudgeKey(event)]);
      let pushed = 0;
      for (const { event, external } of due) {
        const out = await notifyUser(username, nudgeNotification(event, external, now), { onceKeys: [nudgeKey(event)] });
        pushed += out.pushed;
      }
      results[username] = { ok: true, due: due.length, pushed };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[cron/premeeting] ${username}: ${msg}`);
      results[username] = { ok: false, error: msg.slice(0, 200) };
    }
  }
  return NextResponse.json({ ok: true, results });
}
