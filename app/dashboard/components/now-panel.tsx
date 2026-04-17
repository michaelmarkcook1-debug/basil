"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Calendar, Sparkles, Users, Video } from "lucide-react";
import { formatTime } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  isAllDay?: boolean;
  hasVideo?: boolean;
  attendeeCount?: number;
}

function countdown(ms: number): string {
  if (ms <= 0) return "now";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hrs < 24) return remMins > 0 ? `in ${hrs}h ${remMins}m` : `in ${hrs}h`;
  return `in ${Math.floor(hrs / 24)}d`;
}

export function NowPanel() {
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    fetch("/api/calendar")
      .then((r) => r.json())
      .then((d) => setEvents(d?.events ?? []))
      .catch(() => setEvents([]));
  }, []);

  // Tick every 30s for live countdown
  useEffect(() => {
    const i = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(i);
  }, []);

  if (events === null) {
    return (
      <div className="relative overflow-hidden rounded-2xl p-7 bg-sidebar text-sidebar-foreground">
        <Skeleton className="h-3 w-20 mb-3 bg-white/10" />
        <Skeleton className="h-8 w-48 mb-4 bg-white/10" />
        <Skeleton className="h-4 w-32 bg-white/10" />
      </div>
    );
  }

  const now = Date.now();
  const upcoming = events
    .filter((e) => !e.isAllDay && new Date(e.end).getTime() > now)
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  const current = upcoming.find(
    (e) => new Date(e.start).getTime() <= now && new Date(e.end).getTime() > now
  );
  const next = current ?? upcoming[0];

  const isActive = !!current;
  const startMs = next ? new Date(next.start).getTime() : 0;
  const endMs = next ? new Date(next.end).getTime() : 0;
  const relative = isActive ? countdown(endMs - now) : countdown(startMs - now);

  return (
    <div className="relative overflow-hidden rounded-2xl bg-sidebar text-sidebar-foreground">
      {/* Ambient gold glow */}
      <div
        aria-hidden
        className="absolute inset-0 opacity-80"
        style={{
          background:
            "radial-gradient(500px 200px at 85% -40%, oklch(0.72 0.15 85 / 0.22), transparent 60%), radial-gradient(400px 300px at 10% 120%, oklch(0.72 0.15 85 / 0.08), transparent 55%)",
        }}
      />
      {/* Gold hairline top */}
      <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-[oklch(0.72_0.15_85)]/60 to-transparent" />

      <div className="relative p-4 sm:p-7 flex flex-col min-h-[160px] sm:min-h-[220px]">
        <div className="flex items-center gap-2 mb-4">
          <span
            className={`inline-flex h-2 w-2 rounded-full ${
              isActive ? "bg-red-400 animate-pulse" : "bg-[oklch(0.72_0.15_85)]"
            }`}
          />
          <p className="text-[12px] font-semibold uppercase tracking-[0.22em] text-sidebar-foreground/60">
            {isActive ? "In Progress" : next ? "Up Next" : "Today"}
          </p>
          <span className="ml-auto text-[12px] font-mono text-sidebar-foreground/50">
            {relative}
          </span>
        </div>

        {next ? (
          <>
            <h2 className="basil-display text-[22px] sm:text-[26px] leading-tight text-white mb-3">
              {next.summary}
            </h2>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-sidebar-foreground/70">
              <span className="font-mono tabular-nums text-[oklch(0.82_0.12_85)]">
                {formatTime(next.start)} — {formatTime(next.end)}
              </span>
              {next.hasVideo && (
                <span className="flex items-center gap-1">
                  <Video className="h-3 w-3" /> Video
                </span>
              )}
              {(next.attendeeCount ?? 0) > 0 && (
                <span className="flex items-center gap-1">
                  <Users className="h-3 w-3" /> {next.attendeeCount}
                </span>
              )}
            </div>

            <div className="mt-auto pt-6 flex items-center gap-3">
              <Link
                href="/dashboard/meetings"
                className="group inline-flex items-center gap-2 rounded-lg bg-[oklch(0.72_0.15_85)] px-4 py-2 text-xs font-medium tracking-tight text-[oklch(0.18_0.04_250)] shadow-sm hover:shadow-md hover:bg-[oklch(0.76_0.14_85)] transition-all"
              >
                <Sparkles className="h-3.5 w-3.5" />
                Generate prep
                <ArrowRight className="h-3.5 w-3.5 group-hover:translate-x-0.5 transition-transform" />
              </Link>
              <Link
                href="/dashboard/schedule"
                className="text-xs text-sidebar-foreground/60 hover:text-[oklch(0.82_0.12_85)] transition-colors"
              >
                See full day →
              </Link>
            </div>
          </>
        ) : (
          <>
            <h2 className="basil-display text-[26px] leading-tight text-white mb-2">
              Clear ahead
            </h2>
            <p className="text-sm text-sidebar-foreground/60 max-w-sm">
              Nothing else on the calendar today. Use the open space for deep
              work or to close open loops.
            </p>
            <div className="mt-auto pt-6">
              <Link
                href="/dashboard/actions"
                className="inline-flex items-center gap-2 text-xs font-medium text-[oklch(0.82_0.12_85)] hover:text-[oklch(0.72_0.15_85)] transition-colors"
              >
                <Calendar className="h-3.5 w-3.5" />
                Review open actions
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
