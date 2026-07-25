"use client";

/**
 * Dashboard home — the "Today" command center.
 *
 * A full-width, data-visualized cockpit (not a narrow text feed):
 *   • A KPI stat row (needs-you / focus / awaiting-reply / commitments) with
 *     ring + bar micro-viz, so the state of the day reads in one glance.
 *   • A proportional day TIMELINE (block height = real duration, live "now" line).
 *   • An attention DONUT — where today's signals are actually coming from.
 *   • A ranked priority feed (critical + needs-you) with inline actions.
 *
 * Data: GET /api/today (ranked change/followup/linear feed) + /api/calendar +
 * /api/actions + /api/generate/briefing.
 */

import { useState, useEffect } from "react";
import useSWR, { mutate } from "swr";
import Link from "next/link";
import { Newspaper, ChevronDown, ArrowUpRight, Sparkles, Inbox, Activity, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { TodayCard } from "@/components/today/today-card";
import { LearningPrompt } from "@/components/today/learning-prompt";
import { WeeklyBriefCard } from "@/components/today/weekly-brief-card";
import { StatCard, AttentionDonut, DayTimeline, buildDayBlocks } from "@/components/today/dashboard-viz";
import type { TodayFeedResponse, TodayFollowupItem } from "@/lib/today/types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function getGreeting(hour: number): string {
  if (hour < 5) return "Good night";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  if (hour < 21) return "Good evening";
  return "Good night";
}

function isToday(dateStr: string): boolean {
  const d = new Date(dateStr);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

interface CalendarEvent {
  id: string; summary: string; start: string; end: string;
  isAllDay?: boolean; hasVideo?: boolean; attendeeCount?: number;
}
interface BriefingData {
  generatedAt?: string;
  criticalToday?: string | null; projectRadar?: string | null; followUps?: string | null;
  decisionsToWatch?: string | null; meetingsNeedingPrep?: string | null;
  peopleAndAccounts?: string | null; inboxSlack?: string | null;
}
interface ActionRecord {
  status?: string;
  archivedReason?: string;
  /** ISO yyyy-mm-dd. Drives the overdue / due-soon split in the Commitments KPI. */
  dueDate?: string;
}

// THROW on a bad response — do not resolve to null. Swallowing the status here
// meant SWR never saw an error, so `isLoading` went false with `items` empty and
// the page announced "All clear — nothing needs you right now." during an
// outage. For an assistant whose whole job is "I'll tell you what needs you",
// a failure that reassures you is the one failure you'd never think to retry.
const swrFetch = async (url: string) => {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url} failed (${r.status})`);
  return r.json();
};
const SWR_OPTS = { revalidateOnFocus: false, dedupingInterval: 30_000 };

const BRIEFING_SECTIONS: Array<{ key: keyof BriefingData; label: string }> = [
  { key: "criticalToday", label: "Critical today" },
  { key: "followUps", label: "Follow-ups" },
  { key: "meetingsNeedingPrep", label: "Meetings needing prep" },
  { key: "decisionsToWatch", label: "Decisions to watch" },
  { key: "projectRadar", label: "Project radar" },
  { key: "peopleAndAccounts", label: "People & accounts" },
  { key: "inboxSlack", label: "Inbox & Slack" },
];

const WORKDAY_MINS = 11 * 60; // 8am–7pm reference window for the focus ring

// ── Page ────────────────────────────────────────────────────────────────────────

export default function DashboardHome() {
  const [hour, setHour] = useState(9);
  const [nowMin, setNowMin] = useState(9 * 60);
  const [dateLabel, setDateLabel] = useState("");
  const [briefingOpen, setBriefingOpen] = useState(false);
  const [showAllNeeds, setShowAllNeeds] = useState(false);
  const [showLater, setShowLater] = useState(false);

  const NEEDS_VISIBLE = 6;

  useEffect(() => {
    const now = new Date();
    setHour(now.getHours());
    setNowMin(now.getHours() * 60 + now.getMinutes());
    const tz = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined;
    setDateLabel(now.toLocaleDateString("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }));
  }, []);

  const { data: settings } = useSWR("/api/settings", swrFetch, SWR_OPTS);
  const { data: feed, isLoading, error: feedError } = useSWR<TodayFeedResponse>("/api/today", swrFetch, SWR_OPTS);
  const { data: calendarData } = useSWR("/api/calendar", swrFetch, SWR_OPTS);
  const { data: actionsData } = useSWR("/api/actions", swrFetch, SWR_OPTS);
  const { data: briefingData } = useSWR("/api/generate/briefing", swrFetch, { ...SWR_OPTS, dedupingInterval: 5 * 60_000 });

  const firstName = settings?.name?.split(" ")[0] ?? "";
  const events: CalendarEvent[] = calendarData?.events ?? [];
  const briefing: BriefingData | null = briefingData ?? null;

  const items = feed?.items ?? [];
  const critical = items.filter((i) => i.lane === "critical");
  const needsYou = items.filter((i) => i.lane === "needs-you");
  const linear = items.filter((i) => i.lane === "linear");
  const later = items.filter((i) => i.lane === "later");
  const linearConnected = feed?.sources.linear ?? false;

  const todaysEvents = events
    .filter((e) => !e.isAllDay && isToday(e.start))
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  const criticalCount = critical.length;
  const totalNeeds = critical.length + needsYou.length;
  const focusTask = critical[0]?.subtitle ?? needsYou.find((i) => i.kind === "change")?.subtitle;

  // ── KPI derivations ──────────────────────────────────────────────────────────
  const followups = items.filter((i): i is TodayFollowupItem => i.kind === "followup");
  const oldestWait = followups.reduce((m, f) => Math.max(m, f.followup.hoursWaiting ?? 0), 0);

  const dayBlocks = buildDayBlocks(todaysEvents, focusTask);
  const meetingMins = dayBlocks.filter((b) => b.type === "meeting").reduce((n, b) => n + (b.endMin - b.startMin), 0);
  // "Focus today" = actual UNBOOKED time in the workday (workday − meetings), not
  // the sum of a hardcoded suggested focus block (which only ever read 1.5h or 0h
  // regardless of the real calendar). This is an honest, calendar-derived number.
  const focusMins = Math.max(0, WORKDAY_MINS - meetingMins);
  const focusHrs = Math.round((focusMins / 60) * 10) / 10;

  const actionList: ActionRecord[] = Array.isArray(actionsData)
    ? actionsData
    : Array.isArray(actionsData?.actions)
      ? actionsData.actions
      : [];
  const openList = actionList.filter((a) => a.status !== "done" && a.status !== "deleted" && a.status !== "dismissed");
  const openActions = openList.length;
  // Genuine completions only — items auto-retired by a lifecycle sweep carry an
  // archivedReason and must NOT inflate the completion rate as if you finished them.
  const doneActions = actionList.filter((a) => a.status === "done" && !a.archivedReason).length;

  // ── What this KPI measures, and why it changed ──────────────────────────────
  // It used to headline the OPEN COUNT (429) with a lifetime completion ring
  // (8%). Both were technically true and practically useless: Basil manufactures
  // commitments from every email and meeting, so the denominator is the machine's
  // output, not Michael's workload. "8% complete" reads as personal failure for
  // keeping up with an inbox, and 429 is a number nobody can act on.
  // Headline the only figure that asks for a decision — what is overdue or due
  // soon — and keep the backlog as context, mirroring how /dashboard/actions
  // already buckets OVERDUE / UPCOMING.
  const todayStr = new Date().toISOString().slice(0, 10);
  const soonStr = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const overdueActions = openList.filter(
    (a) => a.status === "overdue" || (!!a.dueDate && a.dueDate < todayStr)
  ).length;
  const dueSoonActions = openList.filter(
    (a) => !!a.dueDate && a.dueDate >= todayStr && a.dueDate <= soonStr
  ).length;
  const needsAction = overdueActions + dueSoonActions;

  // Attention donut — where today's signals come from.
  const nChange = items.filter((i) => i.kind === "change").length;
  const nFollow = followups.length;
  const nLinear = items.filter((i) => i.kind === "linear").length;
  const donutSegments = [
    {
      label: "Signals",
      value: nChange,
      color: "var(--gold)",
      href: "#radar",
      hint: `${nChange} change${nChange === 1 ? "" : "s"} across your actions, decisions & projects. Click to jump to the feed.`,
    },
    {
      label: "Awaiting reply",
      value: nFollow,
      color: "var(--signal-info)",
      // Point to the feed where the ACTUAL follow-up cards (email + Slack) live —
      // not the Slack-only command centre, which computes a different count and
      // would visibly disagree with this number for Gmail follow-ups.
      href: "#radar",
      hint: `${nFollow} message${nFollow === 1 ? "" : "s"} (email + Slack) waiting on your reply. Click to jump to the feed.`,
    },
    {
      label: "Linear",
      value: nLinear,
      color: "var(--signal-positive)",
      href: "/dashboard/linear",
      hint: `${nLinear} hot Linear issue${nLinear === 1 ? "" : "s"} (urgent or due soon). Click to open Linear.`,
    },
  ];
  const signalTotal = nChange + nFollow + nLinear;

  return (
    <div className="relative min-h-full">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-56 opacity-50"
        style={{ background: "radial-gradient(720px 220px at 70% 0%, rgba(200,169,107,0.16), transparent 70%)" }}
      />

      <div className="relative mx-auto max-w-6xl px-5 py-6 lg:px-8 space-y-5">
        {/* ── Header ──────────────────────────────────────────────────────────── */}
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground/70">{dateLabel}</p>
            <h1 className="mt-1 text-[28px] font-semibold tracking-tight text-foreground">
              {getGreeting(hour)}{firstName ? `, ${firstName}` : ""}.
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {isLoading ? "Scanning your day…"
                : feedError ? "Couldn't reach your sources — this is not an all-clear."
                : totalNeeds === 0 ? "All clear — nothing needs you right now."
                : <>
                    <span className="font-medium text-foreground">{totalNeeds}</span> {totalNeeds === 1 ? "thing needs" : "things need"} you
                    {criticalCount > 0 && <> · <span className="font-medium text-signal-critical">{criticalCount} critical</span></>}
                    {meetingMins > 0 && <> · <span className="text-muted-foreground">{Math.round((meetingMins / 60) * 10) / 10}h in meetings</span></>}
                  </>}
            </p>
          </div>
          <Link
            href="/dashboard/chat"
            className="inline-flex items-center gap-2 rounded-xl border border-gold/30 bg-gold/[0.08] px-3.5 py-2 text-sm font-medium text-gold transition-colors hover:bg-gold/[0.14]"
          >
            <Sparkles className="h-4 w-4" /> Ask Basil
          </Link>
        </header>

        {/* ── KPI stat row ────────────────────────────────────────────────────── */}
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            label="Needs you"
            value={totalNeeds}
            accent="var(--signal-critical)"
            href="#radar"
            summary={`${totalNeeds} item${totalNeeds === 1 ? "" : "s"} need your attention${criticalCount > 0 ? `, ${criticalCount} critical` : ""}. ${later.length} can wait. Click to jump to the feed.`}
            sub={criticalCount > 0 ? <span className="text-signal-critical">{criticalCount} critical</span> : `${later.length} can wait`}
            bar={[
              { value: totalNeeds ? critical.length / Math.max(totalNeeds + later.length, 1) : 0, color: "var(--signal-critical)" },
              { value: needsYou.length / Math.max(totalNeeds + later.length, 1), color: "var(--gold)" },
              { value: later.length / Math.max(totalNeeds + later.length, 1), color: "var(--border)" },
            ]}
          />
          <StatCard
            label="Focus today"
            value={`${focusHrs}h`}
            accent="var(--signal-positive)"
            href="/dashboard/schedule"
            summary={`${focusHrs}h of focus time available today · ${Math.round((meetingMins / 60) * 10) / 10}h booked in meetings. Click to open your schedule.`}
            sub={`${Math.round((meetingMins / 60) * 10) / 10}h booked`}
            ring={{ value: focusMins / WORKDAY_MINS, center: <Activity className="h-4 w-4 text-signal-positive" /> }}
          />
          <StatCard
            label="Awaiting reply"
            value={nFollow}
            accent="var(--signal-info)"
            href="#radar"
            summary={`${nFollow} message${nFollow === 1 ? "" : "s"} (email + Slack) awaiting your reply${oldestWait > 0 ? `, oldest waiting ${Math.round(oldestWait)}h` : ""}. Click to jump to the feed.`}
            sub={oldestWait > 0 ? `oldest ${Math.round(oldestWait)}h` : "inbox calm"}
          />
          <StatCard
            label="Commitments"
            value={needsAction}
            accent="var(--gold)"
            href="/dashboard/actions"
            summary={
              needsAction === 0
                ? `Nothing due in the next 7 days. ${openActions} tracked in the background, ${doneActions} done. Click to open Commitments.`
                : `${overdueActions} overdue · ${dueSoonActions} due in the next 7 days. ${openActions} tracked in total (Basil creates these from your email and meetings, so the backlog is not a to-do list). Click to open Commitments.`
            }
            sub={
              overdueActions > 0
                ? <span className="text-signal-critical">{overdueActions} overdue</span>
                : needsAction > 0 ? "due in 7 days" : `${openActions} tracked`
            }
          />
        </section>

        {/* ── Main grid: day timeline + attention ─────────────────────────────── */}
        <section className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            {calendarData ? (
              <DayTimeline events={todaysEvents} focusTask={focusTask} nowMin={nowMin} />
            ) : (
              <div className="h-full min-h-[200px] animate-pulse rounded-2xl border border-border/40 bg-card/30" />
            )}
          </div>
          <div className="space-y-4">
            <div className="rounded-2xl border border-border/60 bg-card/60 p-5">
              <h2 className="mb-4 text-sm font-semibold tracking-tight text-foreground">Where your attention is</h2>
              <AttentionDonut segments={donutSegments} total={signalTotal} />
            </div>
            <LearningPrompt />
          </div>
        </section>

        {/* ── Priority feed ───────────────────────────────────────────────────── */}
        {/* Scroll target for the "Needs you" KPI click-through. */}
        <div id="radar" className="scroll-mt-20" aria-hidden />
        {isLoading && (
          <div className="grid gap-2 sm:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-xl border border-border/40 bg-card/30" />
            ))}
          </div>
        )}

        {!isLoading && critical.length > 0 && (
          <section className="space-y-2">
            <SectionLabel tone="critical">Critical · act now</SectionLabel>
            {critical.map((item) => <TodayCard key={item.id} item={item} />)}
          </section>
        )}

        {!isLoading && needsYou.length > 0 && (
          <section className="space-y-2">
            <SectionLabel>Needs you now</SectionLabel>
            <div className="grid gap-2 lg:grid-cols-2">
              {(showAllNeeds ? needsYou : needsYou.slice(0, NEEDS_VISIBLE)).map((item) => (
                <TodayCard key={item.id} item={item} />
              ))}
            </div>
            {needsYou.length > NEEDS_VISIBLE && (
              <button
                onClick={() => setShowAllNeeds((v) => !v)}
                className="mt-1 w-full rounded-lg border border-border/40 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:text-gold"
              >
                {showAllNeeds ? "Show less" : `Show ${needsYou.length - NEEDS_VISIBLE} more`}
              </button>
            )}
          </section>
        )}

        {/* A failed feed must never render as an empty one. */}
        {!isLoading && feedError && (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-signal-critical-border bg-signal-critical-subtle py-12 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-signal-critical/10 text-signal-critical"><AlertTriangle className="h-5 w-5" /></span>
            <p className="mt-3 text-sm font-medium text-foreground">Couldn&apos;t load your day</p>
            <p className="mt-1 max-w-sm text-xs text-muted-foreground">
              Basil couldn&apos;t reach your sources, so this screen is empty because of an error — not because nothing needs you.
            </p>
            <button
              onClick={() => mutate("/api/today")}
              className="mt-4 rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-card/60"
            >
              Try again
            </button>
          </div>
        )}

        {!isLoading && !feedError && totalNeeds === 0 && (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-border/50 bg-card/30 py-12 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-gold/10 text-gold"><Sparkles className="h-5 w-5" /></span>
            <p className="mt-3 text-sm font-medium text-foreground">Nothing needs you right now</p>
            <p className="mt-1 text-xs text-muted-foreground">Basil is watching your sources and will surface anything that matters.</p>
          </div>
        )}

        {!isLoading && later.length > 0 && (
          <section className="space-y-2">
            <button
              onClick={() => setShowLater((v) => !v)}
              className="flex w-full items-center justify-between rounded-lg border border-border/40 px-3 py-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground"
            >
              <span className="flex items-center gap-2">
                <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", showLater && "rotate-180")} />
                Can wait <span className="text-muted-foreground/60">· {later.length}</span>
              </span>
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground/50">learned</span>
            </button>
            {showLater && <div className="grid gap-2 lg:grid-cols-2">{later.map((item) => <TodayCard key={item.id} item={item} />)}</div>}
          </section>
        )}

        {!isLoading && (linear.length > 0 || !linearConnected) && (
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <SectionLabel>Linear</SectionLabel>
              <Link href="/dashboard/linear" className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-gold">
                Open Linear <ArrowUpRight className="h-3 w-3" />
              </Link>
            </div>
            {linearConnected ? (
              linear.length > 0 ? (
                <div className="grid gap-2 lg:grid-cols-2">{linear.map((item) => <TodayCard key={item.id} item={item} />)}</div>
              ) : (
                <p className="rounded-xl border border-border/40 bg-card/30 px-4 py-3 text-xs text-muted-foreground">No hot issues — nothing urgent or due soon.</p>
              )
            ) : (
              <Link href="/dashboard/settings" className="block rounded-xl border border-border/40 bg-card/30 px-4 py-3 text-xs text-muted-foreground transition-colors hover:text-gold">
                Connect Linear to surface hot issues here →
              </Link>
            )}
          </section>
        )}

        {briefing && (
          <section>
            <button
              onClick={() => setBriefingOpen((v) => !v)}
              className="flex w-full items-center gap-2.5 rounded-xl border border-border/60 bg-card/40 px-4 py-3 text-left transition-all hover:bg-card/70"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gold/10 text-gold"><Newspaper className="h-3.5 w-3.5" /></span>
              <div className="flex-1">
                <p className="text-sm font-medium text-foreground">Full briefing</p>
                <p className="text-xs text-muted-foreground">Your complete chief-of-staff read</p>
              </div>
              <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", briefingOpen && "rotate-180")} />
            </button>
            {briefingOpen && (
              <div className="mt-2 grid gap-4 rounded-xl border border-border/40 bg-card/20 px-4 py-4 md:grid-cols-2">
                {BRIEFING_SECTIONS.filter((s) => briefing[s.key]).map((s) => (
                  <div key={s.key}>
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gold/80">{s.label}</p>
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/85">{briefing[s.key]}</p>
                  </div>
                ))}
                {BRIEFING_SECTIONS.every((s) => !briefing[s.key]) && <p className="text-sm text-muted-foreground">No briefing generated yet today.</p>}
              </div>
            )}
          </section>
        )}

        {/* Weekly brief — the week-scale companion to the daily briefing above.
            Renders unconditionally (unlike the briefing, which needs data to
            exist first) because it owns its own empty + generate states. */}
        <WeeklyBriefCard />

        {!isLoading && feed && !feed.sources.followups.gmail && !feed.sources.followups.slack && !feed.sources.linear && items.length === 0 && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground/70">
            <Inbox className="h-3.5 w-3.5" /> Connect Gmail, Slack, or Linear in Settings to start surfacing signals.
          </p>
        )}
      </div>
    </div>
  );
}

function SectionLabel({ children, tone }: { children: React.ReactNode; tone?: "critical" }) {
  return (
    <h2 className={cn(
      "text-[11px] font-semibold uppercase tracking-[0.14em]",
      tone === "critical" ? "text-signal-critical" : "text-muted-foreground/70"
    )}>
      {children}
    </h2>
  );
}
