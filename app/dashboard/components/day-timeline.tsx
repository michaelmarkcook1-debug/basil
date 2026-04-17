"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Calendar, Video, Users, Unplug } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatTime } from "@/lib/utils";
import { cn } from "@/lib/utils";

interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  isAllDay?: boolean;
  hasVideo?: boolean;
  attendeeCount?: number;
}

interface CalendarResponse {
  connected: boolean;
  events: CalendarEvent[];
  message: string;
}

const DAY_START_HOUR = 7;
const DAY_END_HOUR = 20;
const TOTAL_HOURS = DAY_END_HOUR - DAY_START_HOUR;

function hoursFromMidnight(date: Date): number {
  return date.getHours() + date.getMinutes() / 60;
}

// ── Event categorization ──
// Keep the palette aligned with briefing sections so colors carry meaning
// across the whole app: gold = meetings, emerald = focus, rose = break, etc.
type EventCategory = "meeting" | "focus" | "break" | "admin" | "personal";

interface CategoryStyle {
  label: string;
  /** tailwind bg classes for live events */
  bg: string;
  /** tailwind ring class */
  ring: string;
  /** shadow glow */
  glow: string;
  /** swatch used in legend */
  swatch: string;
  /** text color on block */
  text: string;
}

const CATEGORY_STYLES: Record<EventCategory, CategoryStyle> = {
  meeting: {
    label: "Meeting",
    bg: "bg-[oklch(0.72_0.15_85)]/85",
    ring: "ring-[oklch(0.72_0.15_85)]",
    glow: "shadow-[0_2px_8px_-2px_oklch(0.72_0.15_85_/_0.5)]",
    swatch: "bg-[oklch(0.72_0.15_85)]",
    text: "text-[oklch(0.18_0.04_250)]",
  },
  focus: {
    label: "Focus",
    bg: "bg-emerald-500/85",
    ring: "ring-emerald-600",
    glow: "shadow-[0_2px_8px_-2px_oklch(0.65_0.18_145_/_0.45)]",
    swatch: "bg-emerald-500",
    text: "text-white",
  },
  break: {
    label: "Break",
    bg: "bg-rose-400/85",
    ring: "ring-rose-500",
    glow: "shadow-[0_2px_8px_-2px_oklch(0.65_0.18_15_/_0.4)]",
    swatch: "bg-rose-400",
    text: "text-white",
  },
  admin: {
    label: "Review",
    bg: "bg-blue-500/85",
    ring: "ring-blue-600",
    glow: "shadow-[0_2px_8px_-2px_oklch(0.55_0.18_250_/_0.45)]",
    swatch: "bg-blue-500",
    text: "text-white",
  },
  personal: {
    label: "Personal",
    bg: "bg-violet-500/85",
    ring: "ring-violet-600",
    glow: "shadow-[0_2px_8px_-2px_oklch(0.55_0.18_295_/_0.45)]",
    swatch: "bg-violet-500",
    text: "text-white",
  },
};

function categorizeEvent(summary: string): EventCategory {
  const s = summary.toLowerCase();
  if (/\b(lunch|break|coffee|breakfast|dinner)\b/.test(s)) return "break";
  if (/\b(focus|deep work|block|heads ?down|writing)\b/.test(s)) return "focus";
  if (/\b(review|planning|admin|email|inbox|triage)\b/.test(s)) return "admin";
  if (/\b(gym|workout|personal|family|doctor|appointment)\b/.test(s))
    return "personal";
  return "meeting";
}

export function DayTimeline() {
  const [data, setData] = useState<CalendarResponse | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    fetch("/api/calendar")
      .then((r) => r.json())
      .then(setData)
      .catch(() =>
        setData({ connected: false, events: [], message: "Failed to load" })
      );
  }, []);

  useEffect(() => {
    const i = setInterval(() => setTick((t) => t + 1), 60000);
    return () => clearInterval(i);
  }, []);

  const { timedEvents, nowPct, hourTicks } = useMemo(() => {
    const events = (data?.events ?? []).filter((e) => !e.isAllDay);
    const now = new Date();
    const nowHours = hoursFromMidnight(now);
    const nowPct =
      nowHours >= DAY_START_HOUR && nowHours <= DAY_END_HOUR
        ? ((nowHours - DAY_START_HOUR) / TOTAL_HOURS) * 100
        : null;

    const ticks: number[] = [];
    for (let h = DAY_START_HOUR; h <= DAY_END_HOUR; h += 2) ticks.push(h);

    return { timedEvents: events, nowPct, hourTicks: ticks };
  }, [data]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Calendar className="h-4 w-4 text-[oklch(0.72_0.15_85)]" />
            Today&apos;s Timeline
          </CardTitle>
          <p className="text-[12px] text-muted-foreground mt-0.5">
            {DAY_START_HOUR}:00 — {DAY_END_HOUR}:00
          </p>
        </div>
        {data?.connected && (
          <span className="text-[12px] font-mono text-muted-foreground tabular-nums">
            {timedEvents.length} scheduled
          </span>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {!data ? (
          <Skeleton className="h-40 w-full" />
        ) : !data.connected ? (
          <div className="flex flex-col items-center py-6 text-center">
            <Unplug className="h-8 w-8 text-muted-foreground/40 mb-2" />
            <p className="text-sm text-muted-foreground">{data.message}</p>
            <Link
              href="/dashboard/settings"
              className="text-xs text-[oklch(0.72_0.15_85)] hover:underline mt-2"
            >
              Connect Google Calendar
            </Link>
          </div>
        ) : (
          <>
            {/* Visual track */}
            <div className="relative pt-5">
              {/* hour labels */}
              <div className="flex justify-between text-[12px] font-mono text-muted-foreground/60 mb-1">
                {hourTicks.map((h) => (
                  <span key={h} className="tabular-nums">
                    {h.toString().padStart(2, "0")}
                  </span>
                ))}
              </div>

              {/* track bar */}
              <div className="relative h-10 rounded-md bg-muted/60 ring-1 ring-inset ring-border overflow-hidden">
                {/* subtle hour gridlines */}
                {hourTicks.map((h) => {
                  const pct = ((h - DAY_START_HOUR) / TOTAL_HOURS) * 100;
                  return (
                    <span
                      key={h}
                      className="absolute top-0 bottom-0 w-px bg-border/70"
                      style={{ left: `${pct}%` }}
                    />
                  );
                })}

                {/* event blocks */}
                {timedEvents.map((ev) => {
                  const s = hoursFromMidnight(new Date(ev.start));
                  const e = hoursFromMidnight(new Date(ev.end));
                  const clampedS = Math.max(s, DAY_START_HOUR);
                  const clampedE = Math.min(e, DAY_END_HOUR);
                  if (clampedE <= clampedS) return null;
                  const left = ((clampedS - DAY_START_HOUR) / TOTAL_HOURS) * 100;
                  const width = ((clampedE - clampedS) / TOTAL_HOURS) * 100;
                  const isPast = new Date(ev.end).getTime() < Date.now();
                  const category = categorizeEvent(ev.summary);
                  const style = CATEGORY_STYLES[category];
                  // Show inline label only when block is wide enough to be legible
                  const showLabel = width > 6;
                  return (
                    <div
                      key={ev.id}
                      title={`${ev.summary} · ${formatTime(ev.start)}–${formatTime(ev.end)}`}
                      className={cn(
                        "absolute top-1 bottom-1 rounded-sm ring-1 transition-opacity flex items-center px-1.5 overflow-hidden",
                        style.bg,
                        style.ring,
                        style.text,
                        !isPast && style.glow,
                        isPast && "opacity-45 saturate-75"
                      )}
                      style={{
                        left: `${left}%`,
                        width: `${Math.max(width, 0.8)}%`,
                      }}
                    >
                      {showLabel && (
                        <span className="text-[12px] font-medium leading-none truncate tracking-tight">
                          {ev.summary}
                        </span>
                      )}
                    </div>
                  );
                })}

                {/* "now" marker */}
                {nowPct !== null && (
                  <div
                    className="absolute top-0 bottom-0 w-[2px] bg-red-500 z-10"
                    style={{ left: `${nowPct}%` }}
                  >
                    <span className="absolute -top-1 -translate-x-1/2 h-2 w-2 rounded-full bg-red-500 ring-2 ring-background" />
                  </div>
                )}
              </div>

              {/* Legend — only show categories actually present today */}
              {timedEvents.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2.5 text-[12px] text-muted-foreground">
                  {Array.from(
                    new Set(timedEvents.map((ev) => categorizeEvent(ev.summary)))
                  ).map((cat) => {
                    const s = CATEGORY_STYLES[cat];
                    return (
                      <span
                        key={cat}
                        className="inline-flex items-center gap-1.5"
                      >
                        <span
                          className={cn("h-2 w-2 rounded-sm", s.swatch)}
                        />
                        {s.label}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Event list */}
            <div className="space-y-1">
              {timedEvents.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">
                  No meetings scheduled.
                </p>
              ) : (
                timedEvents.map((ev) => {
                  const isPast = new Date(ev.end).getTime() < Date.now();
                  const isNow =
                    new Date(ev.start).getTime() <= Date.now() &&
                    new Date(ev.end).getTime() > Date.now();
                  const category = categorizeEvent(ev.summary);
                  const style = CATEGORY_STYLES[category];
                  return (
                    <div
                      key={ev.id}
                      className={cn(
                        "group relative flex items-center gap-3 rounded-md -mx-2 pl-3 pr-2 py-1.5 transition-colors hover:bg-accent/40",
                        isPast && "opacity-50"
                      )}
                    >
                      {/* category color bar */}
                      <span
                        className={cn(
                          "absolute left-0 top-2 bottom-2 w-[3px] rounded-full",
                          style.swatch
                        )}
                      />
                      <div
                        className={cn(
                          "shrink-0 font-mono text-[12px] tabular-nums w-[58px]",
                          isNow
                            ? "text-red-500 font-semibold"
                            : isPast
                              ? "text-muted-foreground line-through"
                              : "text-[oklch(0.72_0.15_85)]"
                        )}
                      >
                        {formatTime(ev.start)}
                      </div>
                      <p
                        className={cn(
                          "text-sm truncate flex-1",
                          isPast && "text-muted-foreground"
                        )}
                      >
                        {ev.summary}
                      </p>
                      <div className="flex items-center gap-2 text-muted-foreground/70 text-[12px]">
                        {ev.hasVideo && <Video className="h-3 w-3" />}
                        {(ev.attendeeCount ?? 0) > 0 && (
                          <span className="flex items-center gap-0.5">
                            <Users className="h-3 w-3" />
                            {ev.attendeeCount}
                          </span>
                        )}
                        {isNow && (
                          <span className="text-[12px] uppercase tracking-widest font-semibold text-red-500">
                            live
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
