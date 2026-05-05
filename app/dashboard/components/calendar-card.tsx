"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Calendar, Video, Users, Unplug } from "lucide-react";
import { formatTime } from "@/lib/utils";
import Link from "next/link";

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

function EventTime({ event }: { event: CalendarEvent }) {
  if (event.isAllDay) {
    return <span className="text-[12px] font-mono text-muted-foreground">All day</span>;
  }
  return (
    <span className="text-xs font-mono text-[oklch(0.72_0.15_85)]">
      {formatTime(event.start)}
    </span>
  );
}

function EventTimeRange({ event }: { event: CalendarEvent }) {
  if (event.isAllDay) return <span>All day</span>;
  return <span>{formatTime(event.start)} - {formatTime(event.end)}</span>;
}

export function CalendarCard() {
  const [data, setData] = useState<CalendarResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/calendar")
      .then((res) => res.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch((e: unknown) => {
        console.error("[basil-fetch] network_error", { route: "/api/calendar", component: "CalendarCard", error: e instanceof Error ? e.message : String(e) });
        setData({ connected: false, events: [], message: "Failed to load" });
        setLoading(false);
      });
  }, []);

  // Separate timed events from all-day
  const timedEvents = data?.events.filter((e) => !e.isAllDay) || [];
  const allDayEvents = data?.events.filter((e) => e.isAllDay) || [];

  return (
    <Card className="border-[oklch(0.72_0.15_85)]/30">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium">
          <Calendar className="mr-2 inline h-4 w-4 text-[oklch(0.72_0.15_85)]" />
          Today&apos;s Calendar
        </CardTitle>
        {data && data.connected && (
          <Badge variant="secondary" className="text-xs">
            {timedEvents.length} meetings{allDayEvents.length > 0 ? ` + ${allDayEvents.length} tasks` : ""}
          </Badge>
        )}
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex gap-3">
                <Skeleton className="h-10 w-14 rounded" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : !data?.connected ? (
          <div className="flex flex-col items-center py-6 text-center">
            <Unplug className="h-8 w-8 text-muted-foreground/40 mb-2" />
            <p className="text-sm text-muted-foreground">{data?.message}</p>
            <Link href="/dashboard/settings" className="text-xs text-[oklch(0.72_0.15_85)] hover:underline mt-2">
              Connect Google Calendar
            </Link>
          </div>
        ) : timedEvents.length === 0 && allDayEvents.length === 0 ? (
          <div className="py-6 text-center">
            <p className="text-sm text-muted-foreground">No events today. Clear schedule!</p>
          </div>
        ) : (
          <div className="space-y-2">
            {/* Timed meetings first */}
            {timedEvents.map((event) => {
              const isPast = !event.isAllDay && event.end && new Date(event.end) < new Date();
              return (
                <div
                  key={event.id}
                  className={`flex gap-3 rounded-md p-2 -mx-2 transition-colors hover:bg-accent/50 ${isPast ? "opacity-50" : ""}`}
                >
                  <div className={`flex flex-col items-center justify-center rounded px-2 py-1 text-center min-w-[56px] ${isPast ? "bg-muted" : "bg-[oklch(0.72_0.15_85)]/10"}`}>
                    <EventTime event={event} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-medium truncate ${isPast ? "line-through text-muted-foreground" : ""}`}>{event.summary}</p>
                    <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                      {event.hasVideo && <Video className="h-3 w-3" />}
                      <EventTimeRange event={event} />
                      {(event.attendeeCount ?? 0) > 0 && (
                        <span className="flex items-center gap-0.5">
                          <Users className="h-3 w-3" /> {event.attendeeCount}
                        </span>
                      )}
                      {isPast && <span className="text-[12px] italic">done</span>}
                    </div>
                  </div>
                </div>
              );
            })}
            {/* All-day tasks/reminders */}
            {allDayEvents.length > 0 && (
              <>
                {timedEvents.length > 0 && (
                  <p className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground pt-2">Tasks / Reminders</p>
                )}
                {allDayEvents.map((event) => (
                  <div
                    key={event.id}
                    className="flex gap-3 rounded-md p-2 -mx-2 text-muted-foreground"
                  >
                    <div className="flex items-center justify-center rounded bg-muted px-2 py-1 min-w-[56px]">
                      <span className="text-[12px] font-mono">All day</span>
                    </div>
                    <p className="text-sm truncate">{event.summary}</p>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
