"use client";

/**
 * Today — the executive operational read.
 *
 * WHAT THIS REPLACED: a single "Running copy" column that listed the ranked
 * feed and stopped there. Eight similarly-weighted alerts, three of which were
 * the same stakeholder-silence signal wearing different names, and the day's
 * schedule below all of it. It was a faithful view of the databases and no help
 * at all in deciding what to do.
 *
 * The order here answers, top to bottom: what changed, what matters most, what
 * to do now, which meetings need preparation, where the day is overloaded, and
 * what can wait.
 *
 * MOBILE ORDER is deliberately different from desktop and is enforced with
 * `order-*` utilities rather than duplicated markup: read, then the single most
 * important action, then the timeline, then the other two priorities. Nobody
 * should have to scroll an alert queue to find out when their first meeting is.
 *
 * DATA HONESTY: every number is counted from a store. Where a question has no
 * backing field — how important a person is to you — the surface shows the real
 * observed quantity under its real name, or says it cannot answer.
 */

import useSWR from "swr";
import { useMemo } from "react";
import Link from "next/link";
import type { TodayFeedResponse } from "@/lib/today/types";
import type { CalendarEvent } from "@/lib/google/calendar";
import type { ActionItem } from "@/lib/types/action";
import {
  buildPriorityBoard, buildDayShape, bucketCommitments,
  sourceStates, disconnected, operationalRead, listOf,
  buildStatRow, signalBreakdown, isRelationshipRisk, provenanceOf,
} from "@/lib/today/executive";
import { Hero } from "@/components/today/hero";
import { StatRow } from "@/components/today/stat-row";
import {
  PanelFrame, SignalProvenance, ThreadsPanel, RelationshipPanel, IntelligencePanel,
} from "@/components/today/panels";
import { PriorityActionCard } from "@/components/today/priority-action-card";
import { DayTimeline } from "@/components/today/day-timeline";
import { PressureSection } from "@/components/today/pressure";
import { Watchlist } from "@/components/today/watchlist";
import { Panel, Loading, Failed, Empty } from "@/components/today/primitives";

/**
 * Throws on a bad status. Without this SWR never errors, `isLoading` goes false
 * with an empty list, and the page reports a calm day during an outage — the
 * single worst thing this surface can do.
 */
async function swrFetch(url: string) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

const SWR_OPTS = { revalidateOnFocus: false, dedupingInterval: 30_000 };

export default function Today() {
  const { data: feed, isLoading: feedLoading, error: feedError } =
    useSWR<TodayFeedResponse>("/api/today", swrFetch, SWR_OPTS);
  const { data: cal, error: calError } =
    useSWR<{ connected: boolean; events?: CalendarEvent[] }>("/api/calendar/upcoming", swrFetch, SWR_OPTS);
  const { data: actions, isLoading: actionsLoading, error: actionsError } =
    useSWR<{ actions?: ActionItem[] }>("/api/actions", swrFetch, SWR_OPTS);
  // The greeting needs a name. Failing to load one is not worth an error state —
  // it degrades to a greeting without a name, which still reads correctly.
  const { data: settings } = useSWR<{ name?: string }>("/api/settings", swrFetch, SWR_OPTS);

  // `now` is computed once per render pass rather than per component, so the
  // timeline's "now" marker and the header clock cannot disagree.
  const now = useMemo(() => new Date(), []);

  const board = useMemo(() => buildPriorityBoard(feed?.items ?? []), [feed]);
  const day = useMemo(() => buildDayShape(cal?.events ?? [], now), [cal, now]);
  const buckets = useMemo(
    () => (actions?.actions ? bucketCommitments(actions.actions, now) : null),
    [actions, now],
  );

  const sources = useMemo(() => sourceStates(feed?.sources ?? {
    changes: false, followups: { gmail: false, slack: false }, linear: false,
  }), [feed]);
  const missing = useMemo(() => (feed ? disconnected(feed.sources) : []), [feed]);
  const calConnected = !!cal?.connected && !calError;
  const read = useMemo(
    () => operationalRead(board, day, missing, calConnected),
    [board, day, missing, calConnected],
  );

  const items = useMemo(() => feed?.items ?? [], [feed]);
  const stats = useMemo(
    () => buildStatRow(items, day, buckets, feed?.sources, calConnected),
    [items, day, buckets, feed, calConnected],
  );
  const slices = useMemo(() => signalBreakdown(items), [items]);
  const threads = useMemo(() => items.filter((i) => i.kind === "followup"), [items]);
  const quiet = useMemo(() => items.filter(isRelationshipRisk), [items]);
  const inferredCount = useMemo(
    () => items.filter((i) => provenanceOf(i) === "inferred").length,
    [items],
  );
  // Closed TODAY, counted from the store — not a figure Basil narrates about itself.
  const closedToday = useMemo(() => {
    const d = now.toISOString().slice(0, 10);
    return (actions?.actions ?? []).filter(
      (a) => a.status === "done" && (a as { updatedAt?: string }).updatedAt?.slice(0, 10) === d,
    ).length;
  }, [actions, now]);
  const firstName = (settings?.name ?? "").split(" ")[0] || "there";
  const feedUnavailable = feedError ? "The feed could not be read." : undefined;

  const [first, ...rest] = board.top;

  return (
    <main className="wire min-h-full">
      <div className="mx-auto w-full max-w-[80rem] px-4 sm:px-6 py-4 sm:py-6">

        {/* 1 — Hero: greeting, the read, the mark */}
        <Hero
          name={firstName}
          shape={read.shape}
          risk={read.risk}
          sources={sources}
          now={now}
          generatedAt={feed?.generatedAt}
        />

        {/* 2 — The five counts. Every tile links to what it counts. */}
        <div className="mt-4">
          <h2 className="sr-only">Today at a glance</h2>
          <StatRow stats={stats} />
        </div>

        {/* 3 — Priorities beside the day. On mobile `order` puts the single most
            important action first, then the schedule, then the rest: nobody
            should scroll an alert queue to find their first meeting. */}
        <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-12">
          <div className="contents lg:col-span-8 lg:block">
            <div className="order-1 lg:order-none">
              <Panel title="Top priorities" id="prio-h">
                {feedError ? (
                  <Failed what="Your priorities" onRetry={() => location.reload()} />
                ) : feedLoading ? (
                  <Loading label="Reading your priorities…" rows={3} />
                ) : board.top.length === 0 ? (
                  missing.length === sources.length ? (
                    <Failed what="Every source" />
                  ) : (
                    <Empty>
                      Nothing needs a decision right now.{" "}
                      {missing.length > 0
                        ? `${listOf(missing)} ${missing.length === 1 ? "is" : "are"} not connected, so this is a partial read.`
                        : "Every connected source is reporting."}
                    </Empty>
                  )
                ) : (
                  <div className="space-y-3">
                    {first && <PriorityActionCard priority={first} />}
                  </div>
                )}
              </Panel>
            </div>

            {rest.length > 0 && (
              <div className="order-3 lg:order-none space-y-3 lg:mt-3">
                {rest.map((p) => <PriorityActionCard key={p.id} priority={p} />)}
              </div>
            )}
          </div>

          <aside className="order-2 lg:order-none lg:col-span-4" aria-labelledby="shape-h">
            <div className="lg:sticky lg:top-4">
              <Panel
                title="Today's shape"
                id="shape-h"
                as="aside"
                action={
                  day.meetingCount > 0 ? (
                    <span className="wire-data text-[0.75rem] text-[color:var(--w-ink-soft)]">
                      {day.meetingCount} meeting{day.meetingCount === 1 ? "" : "s"}
                    </span>
                  ) : undefined
                }
              >
                {calError
                  ? <Failed what="Your calendar" onRetry={() => location.reload()} />
                  : <DayTimeline day={day} connected={calConnected} now={now} />}
              </Panel>
            </div>
          </aside>
        </div>

        {/* 4 — Signal, threads, relationships, and what Basil did unattended */}
        <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
          <PanelFrame title="Signal today" href="/dashboard/signals" cta="All signals">
            {feedLoading ? <Loading label="Reading signal…" rows={1} />
              : <SignalProvenance slices={slices} total={items.length} unavailable={feedUnavailable} />}
          </PanelFrame>

          <PanelFrame title="Awaiting your reply" href="/dashboard/threads" cta="All threads">
            {feedLoading ? <Loading label="Reading threads…" rows={1} />
              : <ThreadsPanel items={threads} unavailable={feedUnavailable} />}
          </PanelFrame>

          <PanelFrame title="Relationships" href="/dashboard/contacts" cta="All people">
            {feedLoading ? <Loading label="Reading relationships…" rows={1} />
              : <RelationshipPanel items={quiet} unavailable={feedUnavailable} />}
          </PanelFrame>

          <PanelFrame title="Basil this morning" href="/dashboard/briefing" cta="Full briefing">
            {feedLoading || actionsLoading ? <Loading label="Reading activity…" rows={1} />
              : <IntelligencePanel
                  completedToday={closedToday}
                  inferred={inferredCount}
                  unavailable={actionsError ? "Commitments could not be read." : feedUnavailable}
                />}
          </PanelFrame>
        </div>

        {/* 4 — Pressure and momentum, full width */}
        <div className="mt-6">
          <PressureSection
            day={day}
            calendarConnected={calConnected}
            buckets={buckets}
            commitmentsLoading={actionsLoading}
            commitmentsFailed={!!actionsError}
          />
        </div>

        {/* 5 — Watchlist */}
        <Watchlist items={board.watchlist} />

        <p className="mt-8 text-[0.8125rem] text-[color:var(--w-ink-soft)]">
          <Link href="/dashboard/briefing" className="font-semibold underline underline-offset-2" style={{ color: "var(--w-carbon)" }}>
            Full briefing
          </Link>{" "}
          — the long-form explanation behind this read.
        </p>
      </div>
    </main>
  );
}
