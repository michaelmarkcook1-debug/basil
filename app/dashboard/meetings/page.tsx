"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CalendarCheck, Video, Users, ChevronRight, Unplug } from "lucide-react";
import { formatTime } from "@/lib/utils";
import Link from "next/link";

interface CalEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  isAllDay?: boolean;
  hasVideo?: boolean;
  attendeeCount?: number;
  attendees?: string[];
  dateLabel?: string;
}

export default function MeetingsPage() {
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/calendar/upcoming")
      .then((r) => r.json())
      .then((d) => {
        setConnected(d.connected);
        setEvents((d.events || []).filter((e: CalEvent) => !e.isAllDay));
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  // Group events by dateLabel
  const grouped: Record<string, CalEvent[]> = {};
  for (const e of events) {
    const label = e.dateLabel || "Other";
    if (!grouped[label]) grouped[label] = [];
    grouped[label].push(e);
  }
  const dayOrder = Object.keys(grouped);

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 pb-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <CalendarCheck className="h-6 w-6 text-[oklch(0.72_0.15_85)]" />
          Meeting Prep
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Next 2 days. Click any meeting to generate a cheatsheet.
        </p>
      </header>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-4">
                <div className="flex gap-4">
                  <Skeleton className="h-12 w-20 rounded" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-1/2" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : !connected ? (
        <Card className="border-[oklch(0.72_0.15_85)]/30">
          <CardContent className="py-12 text-center">
            <Unplug className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-muted-foreground">Google Calendar not connected.</p>
            <Link href="/dashboard/settings" className="text-sm text-[oklch(0.72_0.15_85)] hover:underline mt-3 inline-block">
              Go to Settings
            </Link>
          </CardContent>
        </Card>
      ) : events.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">No meetings in the next 2 days.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {dayOrder.map((dayLabel) => (
            <div key={dayLabel}>
              <div className="flex items-center gap-2 mb-3">
                <h2 className="text-sm font-bold uppercase tracking-wider text-[oklch(0.72_0.15_85)]">
                  {dayLabel}
                </h2>
                <div className="flex-1 h-px bg-border" />
                <span className="text-xs text-muted-foreground">
                  {grouped[dayLabel].length} meeting{grouped[dayLabel].length !== 1 ? "s" : ""}
                </span>
              </div>
              <div className="space-y-3">
                {grouped[dayLabel].map((event) => (
                  <Link key={event.id} href={`/dashboard/meetings/${event.id}`}>
                    <Card className="transition-colors hover:bg-accent/30 cursor-pointer mb-3">
                      <CardContent className="p-4">
                        <div className="flex items-center gap-4">
                          <div className="flex flex-col items-center justify-center rounded-lg bg-muted px-3 py-2 text-center min-w-[72px]">
                            <span className="text-sm font-mono font-medium">
                              {formatTime(event.start)}
                            </span>
                            <span className="text-xs text-muted-foreground font-mono">
                              {formatTime(event.end)}
                            </span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <h3 className="font-medium">{event.summary}</h3>
                            <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground flex-wrap">
                              {event.hasVideo && (
                                <span className="flex items-center gap-1">
                                  <Video className="h-3.5 w-3.5" /> Zoom
                                </span>
                              )}
                              {event.attendees && event.attendees.length > 0 && (
                                <span className="flex items-center gap-1 truncate">
                                  <Users className="h-3.5 w-3.5 shrink-0" /> {event.attendees.slice(0, 4).join(", ")}{event.attendees.length > 4 ? ` +${event.attendees.length - 4}` : ""}
                                </span>
                              )}
                            </div>
                          </div>
                          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
