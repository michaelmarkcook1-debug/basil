"use client";

/**
 * Today — Basil's understanding of you, your colleagues and your work, for the
 * day ahead. (Redesigned 2026-10-14: cream canvas, navy chrome, live data
 * graphics.)
 *
 * Top to bottom: a read of the day (the cached morning briefing, or Basil's own
 * no-AI read of the calendar and feed); your orbit (who you're close to right
 * now, how they sound, how to land things with them); the shape of the day;
 * what needs you, with how to approach each person; then your work, what
 * others owe you and the days ahead.
 *
 * COST: nothing here triggers an AI call. Tone is read with ?cached=1, the
 * briefing is the cache-only route, and approach hints are stored profile text.
 *
 * DATA HONESTY: every figure is counted from a store or the calendar. Where a
 * source is missing or failed, the panel says so rather than showing a calm
 * empty state.
 */

import useSWR from "swr";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { TodayFeedResponse, TodayFeedItem } from "@/lib/today/types";
import type { CalendarEvent } from "@/lib/google/calendar";
import type { ActionItem } from "@/lib/types/action";
import {
  buildPriorityBoard, bucketCommitments, disconnected, operationalRead, emptyBoardMessage,
  buildDayShape, sourceStates,
} from "@/lib/today/executive";
import { gmailIdOf, preloadEmails } from "@/components/email/use-email";
import { isWaitingOnOthers } from "@/lib/actions/utils";
import { InvitationsPanel } from "@/components/today/invitations-panel";
import { DayRibbon, buildBlocks, localHours } from "@/components/today/v2/day-ribbon";
import { NeedsYouCard } from "@/components/today/v2/needs-you-card";
import { Orbit, TONE, orbitTone, type OrbitPerson, type SentimentRow } from "@/components/today/v2/orbit";
import { WaitingPanel, NextDaysPanel } from "@/components/today/v2/side-panels";
import { WorkPanel, type ProjectLite } from "@/components/today/v2/work-panel";
import { ReadOfTheDay } from "@/components/today/v2/read-of-the-day";

async function swrFetch(url: string) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}
const SWR_OPTS = { revalidateOnFocus: false, dedupingInterval: 30_000 };
const SLOW_OPTS = { revalidateOnFocus: false, dedupingInterval: 600_000 };

interface ActivityRow { contactId: string; name: string; lastInteraction: string | null; totalInteractionCount: number }

const DAY = 86_400_000;

function lastLabel(days: number): string {
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 14) return `${Math.floor(days)} days ago`;
  return `${Math.floor(days / 7)} weeks ago`;
}

function personOf(item: TodayFeedItem | undefined): string | undefined {
  if (!item) return undefined;
  if (item.kind === "followup") return item.followup.fromName || undefined;
  return undefined;
}

export default function Today() {
  const { data: feed, isLoading: feedLoading, error: feedError } = useSWR<TodayFeedResponse>("/api/today", swrFetch, SWR_OPTS);
  const { data: cal, error: calError } = useSWR<{ connected: boolean; events?: CalendarEvent[] }>("/api/calendar/upcoming", swrFetch, SWR_OPTS);
  const { data: actions, error: actionsError } = useSWR<{ actions?: ActionItem[] }>("/api/actions", swrFetch, SWR_OPTS);
  const { data: settings } = useSWR<{ name?: string; timezone?: string; workStart?: string; workEnd?: string }>("/api/settings", swrFetch, SWR_OPTS);
  const { data: briefing } = useSWR<{ criticalToday?: string | null; generatedAt?: string } | null>("/api/generate/briefing?type=morning", swrFetch, SLOW_OPTS);
  const { data: activity } = useSWR<{ activity?: ActivityRow[] }>("/api/contacts/activity", swrFetch, SLOW_OPTS);
  const { data: tones } = useSWR<{ sentiment?: Record<string, SentimentRow> }>("/api/contacts/sentiment?cached=1", swrFetch, SLOW_OPTS);
  const { data: projects, error: projectsError } = useSWR<{ projects?: ProjectLite[] }>("/api/projects", swrFetch, SLOW_OPTS);

  // `now` starts null (static render) and ticks each minute.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  const clock = useMemo(() => now ?? new Date(0), [now]);
  const timeZone = settings?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const selfName = settings?.name;
  const firstName = (selfName ?? "").split(" ")[0] || "there";

  const items = useMemo(() => feed?.items ?? [], [feed]);
  const board = useMemo(() => buildPriorityBoard(items), [items]);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  const emailIds = useMemo(() => items.flatMap((i) => gmailIdOf(i.id) ?? []).slice(0, 12).join(","), [items]);
  useEffect(() => { if (emailIds) preloadEmails(emailIds.split(",")); }, [emailIds]);

  const events = useMemo(() => cal?.events ?? [], [cal]);
  const calConnected = !!cal?.connected && !calError;
  const day = useMemo(() => buildDayShape(events, clock, timeZone), [events, clock, timeZone]);
  const missing = useMemo(() => (feed ? disconnected(feed.sources) : []), [feed]);
  const degraded = useMemo(() => feed?.degraded ?? [], [feed]);
  const sources = useMemo(() => sourceStates(feed?.sources ?? { changes: false, followups: { gmail: false, slack: false }, linear: false }), [feed]);
  const read = useMemo(() => operationalRead(board, day, missing, calConnected, degraded), [board, day, missing, calConnected, degraded]);

  const blocks = useMemo(() => (now ? buildBlocks(events, clock, timeZone) : []), [events, clock, timeZone, now]);
  // Free time still ahead today (a stretch that has passed is not free any more).
  const nowH = useMemo(() => (now ? localHours(clock.toISOString(), timeZone) : 0), [now, clock, timeZone]);
  const freeHours = useMemo(() => blocks.filter((b) => b.kind === "free").reduce((n, b) => n + Math.max(0, b.end - Math.max(b.start, nowH)), 0), [blocks, nowH]);
  const declinedCount = blocks.filter((b) => b.kind === "declined").length;
  const meetingCount = blocks.filter((b) => b.kind === "meeting").length;

  const all = useMemo(() => actions?.actions ?? [], [actions]);
  const selfNames = useMemo(() => (selfName ? [selfName] : []), [selfName]);
  const mine = useMemo(() => all.filter((a) => a.status !== "done" && !isWaitingOnOthers(a, selfNames)), [all, selfNames]);
  const waiting = useMemo(() => all.filter((a) => a.status !== "done" && isWaitingOnOthers(a, selfNames)), [all, selfNames]);
  const buckets = useMemo(() => (actions ? bucketCommitments(mine, clock, timeZone) : null), [actions, mine, clock, timeZone]);
  const promised = useMemo(() => (buckets ? [
    ...buckets.overdue.map((a) => ({ a, due: "Overdue", color: "#8E2A20" })),
    ...buckets.today.map((a) => ({ a, due: "Due today", color: "#8F3F0E" })),
    ...buckets.next7.map((a) => ({ a, due: a.dueDate ? `Due ${new Date(a.dueDate).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}` : "This week", color: "#4B5568" })),
  ].slice(0, 4) : []), [buckets]);

  // ── People: the orbit, and who each card is about ─────────────────────────
  const selfLower = (selfName ?? "").toLowerCase();
  const orbitPeople: OrbitPerson[] = useMemo(() => {
    const rows = (activity?.activity ?? [])
      .filter((r) => r.lastInteraction && r.name && r.name.toLowerCase() !== selfLower)
      .map((r) => {
        const days = Math.max(0, (clock.getTime() - Date.parse(r.lastInteraction as string)) / DAY);
        return { r, days };
      })
      .filter(({ days }) => days <= 30);
    const active = rows.filter((x) => x.days <= 14).sort((a, b) => b.r.totalInteractionCount - a.r.totalInteractionCount).slice(0, 10);
    const quiet = rows.filter((x) => x.days > 14).sort((a, b) => b.r.totalInteractionCount - a.r.totalInteractionCount).slice(0, 2);
    return [...active, ...quiet].map(({ r, days }) => ({
      name: r.name,
      days,
      volume: r.totalInteractionCount,
      tone: orbitTone(tones?.sentiment?.[r.contactId], days),
      lastLabel: lastLabel(days),
      href: `/dashboard/contacts?id=${encodeURIComponent(r.contactId)}`,
    }));
  }, [activity, tones, clock, selfLower]);

  const cardPeople = useMemo(() => board.top.map((p) => personOf(byId.get(p.id))).filter((n): n is string => !!n), [board, byId]);
  const hintNames = useMemo(() => Array.from(new Set([...orbitPeople.map((p) => p.name), ...cardPeople])).slice(0, 25), [orbitPeople, cardPeople]);
  const { data: hints } = useSWR<{ hints?: { name: string; hint: string }[] }>(
    hintNames.length ? `/api/contacts/approach?names=${encodeURIComponent(hintNames.join(","))}` : null, swrFetch, SLOW_OPTS);
  const hintOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const h of hints?.hints ?? []) if (h.hint) m.set(h.name.toLowerCase(), h.hint);
    return (name?: string) => (name ? m.get(name.toLowerCase()) : undefined);
  }, [hints]);
  const orbitWithHints = useMemo(() => orbitPeople.map((p) => ({ ...p, howTo: hintOf(p.name) })), [orbitPeople, hintOf]);
  const toneOf = useMemo(() => {
    const m = new Map(orbitPeople.map((p) => [p.name.toLowerCase(), TONE[p.tone].color]));
    return (name?: string) => (name ? m.get(name.toLowerCase()) : undefined);
  }, [orbitPeople]);

  const [focus, setFocus] = useState<string | null>(null);

  const readText = useMemo(() => {
    const prose = (briefing?.criticalToday ?? "").replace(/[#*_>`]/g, "").replace(/^\s*[-•]\s*/gm, "").replace(/\s+/g, " ").trim();
    if (prose.length > 40) {
      const sentences = prose.match(/[^.!?]+[.!?]+/g) ?? [prose];
      return sentences.slice(0, 3).join(" ").trim();
    }
    return [read.shape, read.risk].filter(Boolean).join(" ");
  }, [briefing, read]);

  const needsCount = board.top.length;
  const dateLine = now
    ? new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(now)
    : "";
  const greeting = now ? (() => {
    const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(now));
    return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  })() : "Hello";

  return (
    <div className="wire basil-dots relative min-h-full overflow-hidden">
      <span aria-hidden className="pointer-events-none absolute -right-40 -top-56 h-[560px] w-[760px] rounded-full" style={{ background: "radial-gradient(closest-side, rgba(212,185,120,.32), transparent 72%)" }} />
      <div className="relative mx-auto flex w-full max-w-[78rem] flex-col gap-7 px-4 py-6 sm:px-8 sm:py-10">

        {/* 1 — The read, beside your orbit */}
        <div className="flex flex-wrap items-stretch gap-7">
          <ReadOfTheDay
            greeting={greeting}
            name={firstName}
            dateLine={dateLine}
            timeZone={timeZone}
            text={readText}
            fromBriefing={!!briefing?.criticalToday}
            people={orbitPeople.map((p) => p.name)}
            focus={focus}
            onFocus={setFocus}
            stats={[
              { value: calConnected ? String(meetingCount) : "—", label: calConnected ? `meeting${meetingCount === 1 ? "" : "s"}${declinedCount ? ` (${declinedCount} declined)` : ""}` : "calendar not connected" },
              { value: calConnected ? `${Math.floor(freeHours)}${freeHours % 1 >= 0.5 ? "½" : ""}` : "—", unit: " h", label: "free to think, from now" },
              { value: feedError ? "—" : String(needsCount), label: needsCount === 1 ? "thing needs you" : "things need you", dark: true },
            ]}
            sources={sources}
          />
          <div className="min-w-0 flex-[1_1_440px]">
            <Orbit people={orbitWithHints} focus={focus} onFocus={setFocus} />
          </div>
        </div>

        {/* 2 — The shape of the day */}
        <section aria-labelledby="day-h" className="basil-rise flex flex-col gap-4 rounded-[24px] border border-[var(--w-rule)] bg-[var(--w-flimsy)] p-5 sm:p-6" style={{ animationDelay: "220ms" }}>
          <div className="flex flex-wrap items-baseline justify-between gap-2.5">
            <h2 id="day-h" className="basil-serif text-[30px] text-[#10213F]">The shape of your day</h2>
            <span className="flex flex-wrap gap-4 text-[12px] text-[color:var(--w-ink-soft)]">
              <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-3.5 rounded-[3px] bg-[#10213F]" />Meeting</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-3.5 rounded-[3px] border border-[#C8A96B]" style={{ background: "repeating-linear-gradient(135deg, rgba(200,169,107,.6) 0 3px, rgba(200,169,107,.25) 3px 6px)" }} />Free to think</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-3.5 rounded-[3px] border-[1.5px] border-dashed border-[#8A8F99]" />Declined</span>
            </span>
          </div>
          {now && (
            <DayRibbon events={events} now={clock} timeZone={timeZone} connected={calConnected} workStart={settings?.workStart} workEnd={settings?.workEnd} />
          )}
        </section>

        {/* 3 — What needs you, beside your work and the days ahead */}
        <div className="flex flex-wrap items-start gap-7">
          <div className="flex min-w-0 flex-[3_1_560px] flex-col gap-5">
            <div className="flex items-baseline justify-between gap-2.5 px-1">
              <h2 className="basil-serif text-[30px] text-[#10213F]">Needs you</h2>
              <span className="text-[13px] text-[color:var(--w-ink-soft)]">still waiting on you · still valid</span>
            </div>
            {feedError ? (
              <p className="rounded-2xl border border-[var(--w-rule)] bg-[var(--w-flimsy)] p-5 text-[15px] text-[color:var(--w-stamp)]">Your priorities could not be read just now. <button type="button" className="underline" onClick={() => location.reload()}>Try again</button></p>
            ) : feedLoading ? (
              <p className="rounded-2xl border border-[var(--w-rule)] bg-[var(--w-flimsy)] p-5 text-[15px] text-[color:var(--w-ink-soft)]">Reading your priorities…</p>
            ) : board.top.length === 0 ? (
              <p className="rounded-2xl border border-[var(--w-rule)] bg-[var(--w-flimsy)] p-5 text-[15px] text-[color:var(--w-ink-soft)]">Nothing needs a decision right now. {emptyBoardMessage(missing, degraded)}</p>
            ) : (
              board.top.map((p, i) => {
                const person = personOf(byId.get(p.id));
                return (
                  <NeedsYouCard
                    key={p.id}
                    priority={p}
                    person={person}
                    howTo={hintOf(person)}
                    toneColor={toneOf(person)}
                    delay={300 + i * 70}
                    onFocusPerson={setFocus}
                  />
                );
              })
            )}
            {board.watchlist.length > 0 && (
              <p className="px-1 text-[13px] text-[color:var(--w-ink-soft)]">
                {board.watchlist.length} more on the watchlist. <Link href="/dashboard/threads" className="font-medium underline underline-offset-2" style={{ color: "var(--w-carbon)" }}>See everything</Link>
              </p>
            )}

            <InvitationsPanel />

            <section aria-labelledby="promised-h" className="basil-rise flex flex-col gap-1 rounded-[20px] border border-[var(--w-rule)] bg-[var(--w-flimsy)] p-[22px]" style={{ animationDelay: "480ms" }}>
              <div className="flex items-baseline justify-between gap-2.5 pb-2">
                <h2 id="promised-h" className="basil-serif text-[26px] text-[#10213F]">You promised</h2>
                <Link href="/dashboard/actions" className="text-[14px] font-medium no-underline" style={{ color: "var(--w-carbon)" }}>All {mine.length} →</Link>
              </div>
              {actionsError ? (
                <p className="text-[14px] text-[color:var(--w-stamp)]">Commitments could not be read.</p>
              ) : promised.length === 0 ? (
                <p className="text-[14px] text-[color:var(--w-ink-soft)]">Nothing due this week.</p>
              ) : promised.map(({ a, due, color }) => (
                <Link key={a.id} href="/dashboard/actions" className="flex items-start gap-3.5 border-t border-[var(--w-tray)] py-3 text-[color:var(--w-ink)] no-underline">
                  <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
                  <span className="flex flex-col gap-1">
                    <span className="text-[15px] leading-snug">{a.text}</span>
                    <span className="text-[13px] text-[color:var(--w-ink-soft)]"><span className="font-semibold" style={{ color }}>{due}</span> · from {a.source}</span>
                  </span>
                </Link>
              ))}
            </section>
          </div>

          <div className="flex min-w-0 flex-[2_1_360px] flex-col gap-5">
            <WorkPanel projects={projects?.projects} failed={!!projectsError} now={clock} delay={340} />
            <WaitingPanel items={waiting} now={clock} delay={400} />
            {calConnected && now && (
              <NextDaysPanel events={events} now={clock} timeZone={timeZone} delay={460} />
            )}
          </div>
        </div>

        <p className="text-[13px] text-[color:var(--w-ink-soft)]">
          <Link href="/dashboard/briefing" className="font-semibold underline underline-offset-2" style={{ color: "var(--w-carbon)" }}>Full briefing</Link>
          {" "}— the long-form explanation behind this read.
        </p>
      </div>
    </div>
  );
}
