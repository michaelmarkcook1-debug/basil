"use client";

/**
 * The desk — Basil's home surface.
 *
 * THE WIRE DESK (seed basil01, assigned index 3). Your channels are wires;
 * Basil is the desk editor handing you the queue with its sourcing intact.
 *
 * What this REPLACES and why, so it does not creep back:
 *   • the "Good morning, <name>" greeting — a desk states a dateline, not a
 *     salutation, and the briefing already reached the reader by email at 06:15
 *   • the KPI stat row — the hero-metric template (big number, small label,
 *     supporting stats) is the category default and told the reader nothing
 *     they could act on
 *   • the attention donut and focus ring — progress rings standing in for
 *     content; the queue itself is the content
 *   • the proportional day timeline — replaced by the schedule as filed copy
 *
 * What it KEEPS, because it is the actual work: the ranked queue, the day's
 * meetings, and the briefing.
 *
 * Data: GET /api/today, /api/calendar, /api/generate/briefing.
 */

import { useState, useEffect } from "react";
import useSWR from "swr";
import Link from "next/link";
import { Dispatch } from "@/components/wire/dispatch";
import type { TodayFeedResponse, TodayFeedItem } from "@/lib/today/types";

interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  isAllDay?: boolean;
  hasVideo?: boolean;
  attendeeCount?: number;
}

// THROW on a bad response — do not resolve to null. Swallowing the status meant
// SWR never saw an error, so `isLoading` went false with `items` empty and the
// page announced "nothing needs you" during an outage. For an assistant whose
// job is "I'll tell you what needs you", a failure that reassures you is the
// one failure you would never think to retry.
const swrFetch = async (url: string) => {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url} failed (${r.status})`);
  return r.json();
};
const SWR_OPTS = { revalidateOnFocus: false, dedupingInterval: 30_000 };

function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "--:--"
    : d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** A wire's lamp. Down and quiet are DIFFERENT states and must never look alike. */
function Lamp({ state, label }: { state: "up" | "quiet" | "down"; label: string }) {
  const title =
    state === "down"
      ? `${label}: not reachable — this wire is failing, not quiet`
      : state === "quiet"
        ? `${label}: connected, nothing filed`
        : `${label}: filing`;
  return (
    <span className="inline-flex items-center gap-1.5" title={title}>
      <span className={`wire-lamp wire-lamp-${state}`} aria-hidden="true" />
      <span className="wire-data text-[0.6875rem] text-[var(--w-ink-soft)]">{label}</span>
      <span className="sr-only">{title}</span>
    </span>
  );
}

export default function DeskHome() {
  const [dateline, setDateline] = useState("");
  const [showSpiked, setShowSpiked] = useState(false);

  useEffect(() => {
    const now = new Date();
    const tz = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined;
    setDateline(
      now
        .toLocaleDateString("en-GB", { timeZone: tz, weekday: "short", day: "2-digit", month: "short" })
        .toUpperCase(),
    );
  }, []);

  const { data: feed, isLoading, error: feedError } = useSWR<TodayFeedResponse>("/api/today", swrFetch, SWR_OPTS);
  const { data: calendarData, error: calError } = useSWR("/api/calendar", swrFetch, SWR_OPTS);

  const items: TodayFeedItem[] = feed?.items ?? [];
  const events: CalendarEvent[] = calendarData?.events ?? [];

  const running = items.filter((i) => i.lane === "critical" || i.lane === "needs-you");
  const later = items.filter((i) => i.lane === "later" || i.lane === "linear");

  const sources = feed?.sources as Record<string, boolean> | undefined;
  const wireStates: Array<{ label: string; state: "up" | "quiet" | "down" }> = sources
    ? Object.entries(sources).map(([name, connected]) => ({
        label: name.toUpperCase(),
        state: connected ? (items.some((i) => wireName(i) === name.toLowerCase()) ? "up" : "quiet") : "down",
      }))
    : [];

  return (
    <div className="wire min-h-full">
      <div className="mx-auto w-full max-w-[68rem] px-4 sm:px-6 py-5 sm:py-7">
        {/* ── Dateline ──────────────────────────────────────────────────────
            Not a greeting. Where and when copy was filed, and which wires are
            up — the first thing a desk editor checks. */}
        <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <div className="flex items-baseline gap-3 min-w-0">
            <h1 className="wire-slug text-[1.375rem] leading-none tracking-tight text-[var(--w-ink)]">
              The Desk
            </h1>
            <span className="wire-dateline">{dateline || " "}</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {wireStates.map((w) => (
              <Lamp key={w.label} state={w.state} label={w.label} />
            ))}
          </div>
        </header>

        <hr className="wire-rule mt-3" />

        {/* ── Running copy ─────────────────────────────────────────────────── */}
        <section aria-labelledby="running-h" className="mt-5">
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="running-h" className="wire-slug text-[0.8125rem] uppercase tracking-[0.1em] text-[var(--w-ink-soft)]">
              Running copy
            </h2>
            <span className="wire-data text-[0.6875rem] text-[var(--w-ink-soft)]">
              {running.length} outstanding
            </span>
          </div>

          <div className="wire-sheet mt-2 overflow-hidden">
            {feedError ? (
              // An outage is NOT an empty desk. Say which it is.
              <p className="px-4 py-6 text-[0.875rem] text-[var(--w-stamp)]">
                The wire is down — Basil could not read the queue, so this is not
                a quiet desk, it is an unknown one.{" "}
                <button
                  type="button"
                  onClick={() => location.reload()}
                  className="underline underline-offset-2 font-semibold"
                >
                  Retry
                </button>
              </p>
            ) : isLoading ? (
              <p className="px-4 py-6 wire-data text-[0.75rem] text-[var(--w-ink-soft)]">
                Reading the wires…
              </p>
            ) : running.length === 0 ? (
              <p className="px-4 py-6 text-[0.875rem] text-[var(--w-ink-soft)]">
                Nothing outstanding. Every wire above is reporting, so this is a
                quiet desk rather than a silent one.
              </p>
            ) : (
              running.map((item, i) => <Dispatch key={item.id} item={item} seq={i + 1} />)
            )}
          </div>
        </section>

        {/* ── The day ───────────────────────────────────────────────────────
            The schedule as filed copy, not a proportional-block timeline: block
            height encoded duration, which is not what the reader needs to know. */}
        <section aria-labelledby="day-h" className="mt-7">
          <h2 id="day-h" className="wire-slug text-[0.8125rem] uppercase tracking-[0.1em] text-[var(--w-ink-soft)]">
            Scheduled today
          </h2>
          <div className="wire-sheet mt-2 overflow-hidden">
            {calError ? (
              <p className="px-4 py-4 text-[0.875rem] text-[var(--w-stamp)]">
                Calendar unreachable — the day below is unknown, not empty.
              </p>
            ) : events.length === 0 ? (
              <p className="px-4 py-4 text-[0.875rem] text-[var(--w-ink-soft)]">Nothing scheduled.</p>
            ) : (
              events.map((e) => (
                <div key={e.id} className="wire-dispatch">
                  <span className="wire-data text-[0.75rem] text-[var(--w-carbon)] font-bold self-start mt-0.5">
                    {e.isAllDay ? "ALL DAY" : timeOf(e.start)}
                  </span>
                  <div className="min-w-0">
                    <p className="wire-slug text-[0.9375rem] text-[var(--w-ink)] truncate">{e.summary}</p>
                    {e.attendeeCount ? (
                      <p className="wire-data text-[0.6875rem] text-[var(--w-ink-soft)] mt-0.5">
                        {e.attendeeCount} attending
                      </p>
                    ) : null}
                  </div>
                  <span className="wire-data text-[0.6875rem] text-[var(--w-ink-soft)] self-start mt-1">
                    {e.hasVideo ? "VIDEO" : ""}
                  </span>
                </div>
              ))
            )}
          </div>
        </section>

        {/* ── The spike ─────────────────────────────────────────────────────
            Lower-priority copy is set aside, not deleted. The desk keeps what it
            spiked, and the reader can always pull it back. */}
        {later.length > 0 && (
          <section aria-labelledby="spike-h" className="mt-7">
            <button
              type="button"
              onClick={() => setShowSpiked((v) => !v)}
              aria-expanded={showSpiked}
              className="flex items-baseline gap-2 group"
            >
              <h2
                id="spike-h"
                className="wire-slug text-[0.8125rem] uppercase tracking-[0.1em] text-[var(--w-ink-soft)] group-hover:text-[var(--w-ink)]"
              >
                Spiked
              </h2>
              <span className="wire-data text-[0.6875rem] text-[var(--w-ink-soft)]">
                {later.length} held · {showSpiked ? "hide" : "show"}
              </span>
            </button>
            {showSpiked && (
              <div className="wire-spike mt-2 overflow-hidden">
                {later.map((item, i) => (
                  <Dispatch key={item.id} item={item} seq={running.length + i + 1} />
                ))}
              </div>
            )}
          </section>
        )}

        <footer className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-2">
          <Link
            href="/dashboard/briefing"
            className="wire-slug text-[0.8125rem] uppercase tracking-[0.08em] text-[var(--w-carbon)] underline underline-offset-4"
          >
            Full briefing
          </Link>
          <span className="wire-data text-[0.6875rem] text-[var(--w-ink-soft)]">
            filed 06:15 · delivered by email
          </span>
        </footer>
      </div>
    </div>
  );
}

/** Which wire an item arrived on, lower-cased to match the sources map keys. */
function wireName(item: TodayFeedItem): string {
  if (item.kind === "followup") return item.followup.source;
  if (item.kind === "linear") return "linear";
  return item.change.source;
}
