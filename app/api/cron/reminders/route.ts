/**
 * GET /api/cron/reminders — hourly (vercel.json, at :10).
 *
 * Two things Basil now says without being opened (2026-11-10):
 *   • reminders — at the start of the user's working day (Settings → working
 *     hours, in their time zone), once: actions whose follow-up date has come,
 *     that are due today, or that are overdue. Each action reminds once per
 *     date. Nothing on days off: the "while you were away" list covers those.
 *   • connections — when Slack, Gmail, Calendar or another source needs the
 *     user to sign in again, once per break, between 08:00 and 20:00 local.
 *     Read from health-meta.json, which slack-sync and poll-ingest write.
 *
 * No AI calls: this costs nothing but a few Blob reads per user per hour.
 */
import { NextResponse } from "next/server";
import { getUsers } from "@/lib/users";
import { getSettings } from "@/lib/settings/store";
import { listActions } from "@/lib/actions/store";
import { getSelfIdentity } from "@/lib/self-identity";
import { readUserStore } from "@/lib/storage/user-store";
import { HEALTH_META_FILE, type HealthMeta } from "@/lib/system/health";
import { getWorkCalendar } from "@/lib/away/store";
import { awayStatus, dayIn } from "@/lib/away/calendar";
import { alertBrokenConnections, getNotifyState, notifyUser } from "@/lib/notify";
import {
  brokenConnections, connectionNotification, dueReminders, hourIn, reminderKey, reminderNotification, startHour,
} from "@/lib/notify/rules";
import { captureCronFailures } from "@/lib/observability/capture";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const now = Date.now();
  const results: Record<string, unknown> = {};
  for (const user of await getUsers()) {
    if (user.disabled) continue;
    const username = user.username;
    try {
      const settings = await getSettings(username);
      const tz = settings.timezone || "Europe/London";
      const hour = hourIn(now, tz);
      const out: Record<string, unknown> = { ok: true, hour };

      // ── Connections that need reconnecting ──
      if (hour >= 8 && hour < 20) {
        const health = await readUserStore<HealthMeta>(username, HEALTH_META_FILE, {});
        const broken = brokenConnections(health);
        const sent = await alertBrokenConnections(username, broken, connectionNotification);
        if (broken.length > 0) out.connections = { broken: broken.map((b) => b.source), sent };
      }

      // ── Start-of-day reminders ──
      if (hour === startHour(settings.workStart)) {
        const prefs = (await getNotifyState(username)).prefs;
        if (!prefs.reminders) {
          out.reminders = "off";
        } else {
          const cal = await getWorkCalendar(username).catch((e) => {
            console.warn(`[cron/reminders] ${username}: working calendar unreadable, reminding anyway:`, e instanceof Error ? e.message : e);
            return null;
          });
          const today = dayIn(now, cal?.timezone ?? tz);
          const status = cal ? awayStatus(today, cal) : null;
          if (status?.state === "away" || status?.state === "non-working") {
            out.reminders = status.state === "away" ? "away" : status.reason;
          } else {
            const [actions, identity] = await Promise.all([listActions(username), getSelfIdentity(username)]);
            const due = dueReminders(actions, today, tz, identity.names);
            const state = await getNotifyState(username);
            const fresh = due.filter((r) => !state.sent[reminderKey(r)]);
            const n = reminderNotification(fresh);
            out.reminders = n
              ? { count: fresh.length, ...(await notifyUser(username, n, { onceKeys: fresh.map(reminderKey) })) }
              : { count: 0 };
          }
        }
      }
      results[username] = out;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[cron/reminders] ${username}: ${msg}`);
      results[username] = { ok: false, error: msg };
    }
  }

  await captureCronFailures("reminders", results);
  const failed = Object.values(results).filter((r) => !(r as { ok?: boolean }).ok).length;
  return NextResponse.json({ ok: failed === 0, users: Object.keys(results).length, failed, results });
}
