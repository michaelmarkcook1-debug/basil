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
 *   • Pipedrive follow-ups (2026-11-24) — at the start of the working day, for
 *     users who opted in (Settings → Pipedrive: "alert" or "schedule"): one
 *     notification listing follow-ups not alerted before. From the stored
 *     daily copy — no Pipedrive call here.
 *   • chasers (2026-11-24) — at the start of the working day: what others owe
 *     the user that has gone quiet (lib/actions/chasers), once a week each, with
 *     a template chaser queued for approval when the address is known.
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
import { addDays, awayStatus, dayIn } from "@/lib/away/calendar";
import { alertBrokenConnections, getNotifyState, notifyUser } from "@/lib/notify";
import {
  brokenConnections, connectionNotification, dueReminders, hourIn, reminderKey, reminderNotification, startHour,
} from "@/lib/notify/rules";
import { captureCronFailures } from "@/lib/observability/capture";
import { followupState } from "@/lib/pipedrive/followups-server";
import { followupNotification } from "@/lib/pipedrive/alerts";
import { chaseCandidates, chaseKey, chaseNotification, chaserDraft, MAX_PER_DAY } from "@/lib/actions/chasers";
import { getPeopleIndexSafe } from "@/lib/people/directory-store";
import { findPerson } from "@/lib/people/directory";
import { createEventIfNew } from "@/lib/events/store";
import { isFirstWorkingDayOfWeek, isLastWorkingDayOfWeek, weekStart, wrapHour, mondayPlanNotification, fridayWrapNotification } from "@/lib/briefing/week-rhythm";
import { isBacklog } from "@/lib/actions/backlog";
import { weeklyReachOut } from "@/lib/contacts/reach-out";
import { reachOutNotification } from "@/lib/contacts/reach-out-shape";
import { isWaitingOnOthers } from "@/lib/actions/utils";

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

            // ── Chasers: what others owe the user, gone quiet (lib/actions/chasers) ──
            const chases = chaseCandidates(actions, identity.names, now)
              .filter((c) => !state.sent[chaseKey(c.action.id, now)])
              .slice(0, MAX_PER_DAY);
            if (chases.length) {
              const ix = await getPeopleIndexSafe(username).catch((e) => {
                console.warn(`[cron/reminders] ${username}: people directory unreadable, chasers without drafts:`, e instanceof Error ? e.message : e);
                return null;
              });
              const firstName = settings.name?.trim().split(/\s+/)[0] || username;
              let drafted = 0;
              for (const c of chases) {
                const email = ix ? findPerson(ix, c.who)?.emails[0] : undefined;
                if (!email) continue;
                const d = chaserDraft(c, firstName);
                const { created } = await createEventIfNew(username, {
                  sourceRef: chaseKey(c.action.id, now),
                  source: "manual",
                  headline: `Chase ${c.who}: ${c.action.text.slice(0, 80)} (${c.days} days)`,
                  context: `Waiting on ${c.who} for ${c.days} days with no activity: ${c.action.text}`,
                  entityName: c.who,
                  disposition: "draft",
                  priority: "normal",
                  status: "pending",
                  actionType: "send_email",
                  rationale: `Open for ${c.days} days with nothing heard. A template chaser — edit it, send it or drop it.`,
                  confidence: 0.7,
                  tags: ["chaser", "waiting-on"],
                  draft: { channel: "email", to: email, subject: d.subject, body: d.body, generatedAt: new Date(now).toISOString() },
                });
                if (created) drafted++;
              }
              const cn = chaseNotification(chases);
              out.chasers = cn
                ? { count: chases.length, drafted, ...(await notifyUser(username, cn, { onceKeys: chases.map((c) => chaseKey(c.action.id, now)) })) }
                : { count: 0 };
            }
          }
        }
      }
      // ── Monday plan / Friday wrap (lib/briefing/week-rhythm) ──
      const wantPlan = hour === startHour(settings.workStart);
      const wantWrap = hour === wrapHour(settings.workEnd);
      if (wantPlan || wantWrap) {
        const nstate = await getNotifyState(username);
        if (nstate.prefs.weekly) {
          const wcal = await getWorkCalendar(username).catch((e) => {
            console.warn(`[cron/reminders] ${username}: working calendar unreadable, no plan/wrap:`, e instanceof Error ? e.message : e);
            return null;
          });
          const today = dayIn(now, wcal?.timezone ?? tz);
          if (wcal && wantPlan && isFirstWorkingDayOfWeek(today, wcal)) {
            const [acts, ident] = await Promise.all([listActions(username), getSelfIdentity(username)]);
            const weekEnd = addDays(weekStart(today), 6);
            const open = acts.filter((a) => a.status !== "done");
            const waiting = open.filter((a) => a.delegatedTo || isWaitingOnOthers(a, ident.names)).length;
            const dueThisWeek = open.filter((a) => a.dueDate && a.dueDate.slice(0, 10) <= weekEnd).length;
            out.weekPlan = await notifyUser(username, mondayPlanNotification({ dueThisWeek, waiting }), { onceKeys: [`week-plan:${today}`] });
          }
          if (wcal && wantWrap && isLastWorkingDayOfWeek(today, wcal)) {
            const acts = await listActions(username);
            const since = Date.parse(`${weekStart(today)}T00:00:00Z`);
            const doneThisWeek = acts.filter((a) => a.status === "done" && Date.parse(a.lastActivityAt ?? a.updatedAt ?? "") >= since).length;
            const backlog = acts.filter((a) => isBacklog(a, now)).length;
            out.weekWrap = await notifyUser(username, fridayWrapNotification({ doneThisWeek, backlog }), { onceKeys: [`week-wrap:${today}`] });
          }
        }
      }
      // ── Who to reach out to, weekly (lib/contacts/reach-out) ──
      if (hour === startHour(settings.workStart) + 1) {
        const rstate = await getNotifyState(username);
        if (rstate.prefs.relationships) {
          const rcal = await getWorkCalendar(username).catch((e) => {
            console.warn(`[cron/reminders] ${username}: working calendar unreadable, no reach-out list:`, e instanceof Error ? e.message : e);
            return null;
          });
          const rday = dayIn(now, rcal?.timezone ?? tz);
          if (rcal && isFirstWorkingDayOfWeek(rday, rcal)) {
            const people = await weeklyReachOut(username, tz);
            const rn = reachOutNotification(people);
            out.reachOut = rn ? { count: people.length, ...(await notifyUser(username, rn, { onceKeys: [`reach-out:${rday}`] })) } : { count: 0 };
          }
        }
      }
      // ── Pipedrive follow-ups (opt-in) ──
      if (hour === startHour(settings.workStart)) {
        const fu = await followupState(username, { storedOnly: true }).catch((e) => {
          console.warn(`[cron/reminders] ${username}: Pipedrive follow-ups unreadable:`, e instanceof Error ? e.message : e);
          return null;
        });
        if (fu && (fu.automation.mode === "alert" || fu.automation.mode === "schedule") && fu.suggestions.length > 0) {
          const state = await getNotifyState(username);
          const fresh = fu.suggestions.filter((s) => !state.sent[`pd-followup:${s.id}`]);
          const n = followupNotification(fresh);
          out.pipedrive = n
            ? { count: fresh.length, ...(await notifyUser(username, n, { onceKeys: fresh.map((s) => `pd-followup:${s.id}`) })) }
            : { count: 0 };
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
