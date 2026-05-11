"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  CalendarCheck,
  Video,
  Users,
  ChevronRight,
  Unplug,
  ChevronDown,
  ChevronUp,
  Plus,
} from "lucide-react";
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

interface ManualPrep {
  id: string;
  title: string;
  datetime: string;
  attendees: string;
  context: string;
  outcome: string;
  createdAt: string;
}

function ManualPrepForm({ onSaved }: { onSaved: (prep: ManualPrep) => void }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    title: "",
    datetime: "",
    attendees: "",
    context: "",
    outcome: "",
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch("/api/ledger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "meeting",
          source: "manual",
          title: form.title,
          datetime: form.datetime,
          attendees: form.attendees,
          context: form.context,
          outcome: form.outcome,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        onSaved({
          id: data.id ?? String(Date.now()),
          ...form,
          createdAt: new Date().toISOString(),
        });
        setForm({ title: "", datetime: "", attendees: "", context: "", outcome: "" });
        setOpen(false);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-4">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-sm font-medium text-[oklch(0.72_0.15_85)] hover:underline"
      >
        <Plus className="h-4 w-4" />
        Manual Meeting Prep
        {open ? (
          <ChevronUp className="h-3.5 w-3.5" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5" />
        )}
      </button>

      {open && (
        <Card className="mt-3 border-[oklch(0.72_0.15_85)]/30">
          <CardContent className="p-4">
            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <label className="block text-xs font-medium mb-1">Meeting title</label>
                <input
                  required
                  type="text"
                  value={form.title}
                  onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                  placeholder="e.g. Q2 review with Acme"
                  className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-[oklch(0.72_0.15_85)]/40"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Date &amp; time</label>
                <input
                  required
                  type="datetime-local"
                  value={form.datetime}
                  onChange={(e) => setForm((f) => ({ ...f, datetime: e.target.value }))}
                  className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-[oklch(0.72_0.15_85)]/40"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">
                  Attendees{" "}
                  <span className="text-muted-foreground font-normal">(comma-separated)</span>
                </label>
                <input
                  type="text"
                  value={form.attendees}
                  onChange={(e) => setForm((f) => ({ ...f, attendees: e.target.value }))}
                  placeholder="e.g. Alice, Bob, carol@example.com"
                  className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-[oklch(0.72_0.15_85)]/40"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Context / notes</label>
                <textarea
                  value={form.context}
                  onChange={(e) => setForm((f) => ({ ...f, context: e.target.value }))}
                  placeholder="Background, open questions, relevant history…"
                  rows={3}
                  className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-[oklch(0.72_0.15_85)]/40 resize-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Desired outcome</label>
                <input
                  type="text"
                  value={form.outcome}
                  onChange={(e) => setForm((f) => ({ ...f, outcome: e.target.value }))}
                  placeholder="e.g. Agree on Q3 budget"
                  className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-[oklch(0.72_0.15_85)]/40"
                />
              </div>
              <div className="flex gap-2 pt-1">
                <Button type="submit" size="sm" disabled={saving}>
                  {saving ? "Saving…" : "Save prep"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setOpen(false)}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ManualPrepList({ preps }: { preps: ManualPrep[] }) {
  if (preps.length === 0) return null;
  return (
    <div className="space-y-3 mt-4">
      <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
        Saved manual preps
      </h3>
      {preps.map((prep) => (
        <Card key={prep.id} className="border-border/60">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <CalendarCheck className="h-4 w-4 text-[oklch(0.72_0.15_85)] mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p className="font-medium text-sm">{prep.title}</p>
                {prep.datetime && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {new Date(prep.datetime).toLocaleString(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </p>
                )}
                {prep.attendees && (
                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                    <Users className="inline h-3 w-3 mr-1" />
                    {prep.attendees}
                  </p>
                )}
                {prep.outcome && (
                  <p className="text-xs text-muted-foreground mt-1 italic">
                    Goal: {prep.outcome}
                  </p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

interface PastMeetingMemory {
  id: string;
  content: string;
  entity?: string;
  createdAt?: string;
  sourceRef?: string;
  eventId?: string;
}

/** Extracts the meeting title from a Zoom memory content string. */
function parseMeetingMemory(content: string): { title: string; summary: string; date: string } {
  // Format: "[Zoom meeting — Title] Attendees: … Summary text."
  const titleMatch = content.match(/\[Zoom meeting\s*[—–-]\s*([^\]]+)\]/);
  const title = titleMatch ? titleMatch[1].trim() : "Zoom meeting";
  const summary = content.replace(/\[Zoom meeting[^\]]*\]/, "").replace(/Attendees:[^.]*\./, "").trim();
  // Try to extract date from content pattern like "[Zoom meeting — Title (YYYY-MM-DD)]"
  const dateMatch = content.match(/\d{4}-\d{2}-\d{2}/);
  const date = dateMatch ? dateMatch[0] : "";
  return { title, summary, date };
}

export default function MeetingsPage() {
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [manualPreps, setManualPreps] = useState<ManualPrep[]>([]);
  const [pastMeetings, setPastMeetings] = useState<PastMeetingMemory[]>([]);
  const [pastLoading, setPastLoading] = useState(true);

  useEffect(() => {
    fetch("/api/calendar/upcoming")
      .then((r) => r.json())
      .then((d) => {
        setConnected(d.connected);
        setEvents((d.events || []).filter((e: CalEvent) => !e.isAllDay));
        setLoading(false);
      })
      .catch(() => setLoading(false));

    fetch("/api/memory/recent-meetings")
      .then((r) => r.json())
      .then((d) => {
        setPastMeetings(d.memories || []);
        setPastLoading(false);
      })
      .catch(() => setPastLoading(false));
  }, []);

  // Group events by dateLabel
  const grouped: Record<string, CalEvent[]> = {};
  for (const e of events) {
    const label = e.dateLabel || "Other";
    if (!grouped[label]) grouped[label] = [];
    grouped[label].push(e);
  }
  const dayOrder = Object.keys(grouped);

  const handleManualSaved = (prep: ManualPrep) => {
    setManualPreps((prev) => [prep, ...prev]);
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 pb-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <CalendarCheck className="h-6 w-6 text-[oklch(0.72_0.15_85)]" />
          Meeting Prep
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {connected
            ? "Next 2 days. Click any meeting to generate a cheatsheet."
            : "Connect Google Calendar to see upcoming meetings."}
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
        <div className="space-y-6">
          <Card className="border-[oklch(0.72_0.15_85)]/30">
            <CardContent className="py-10 text-center">
              <Unplug className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
              <p className="font-medium">Google Calendar is not connected.</p>
              <p className="text-sm text-muted-foreground mt-1">
                Connect Google Workspace to see upcoming meetings and generate cheatsheets.
              </p>
              <Link href="/dashboard/settings?tab=google">
                <Button className="mt-4" size="sm">
                  Connect Google →
                </Button>
              </Link>
            </CardContent>
          </Card>

          <div>
            <p className="text-sm text-muted-foreground">
              Or create a manual meeting prep:
            </p>
            <ManualPrepForm onSaved={handleManualSaved} />
            <ManualPrepList preps={manualPreps} />
          </div>
        </div>
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
                                  <Users className="h-3.5 w-3.5 shrink-0" />{" "}
                                  {event.attendees.slice(0, 4).join(", ")}
                                  {event.attendees.length > 4
                                    ? ` +${event.attendees.length - 4}`
                                    : ""}
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

      {/* ── Past meeting intelligence (from Zoom email summaries) ──────────── */}
      {(pastLoading || pastMeetings.length > 0) && (
        <div className="mt-8">
          <div className="flex items-center gap-2 mb-4">
            <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
              Past meeting intelligence
            </h2>
            <div className="flex-1 h-px bg-border" />
          </div>
          {pastLoading ? (
            <div className="space-y-3">
              {[0, 1].map((i) => (
                <Card key={i}>
                  <CardContent className="p-4">
                    <Skeleton className="h-4 w-2/3 mb-2" />
                    <Skeleton className="h-3 w-full" />
                    <Skeleton className="h-3 w-3/4 mt-1" />
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              {pastMeetings.map((mem) => {
                const { title, summary, date } = parseMeetingMemory(mem.content);
                return (
                  <Card key={mem.id} className="border-border/60">
                    <CardContent className="p-4">
                      <div className="flex items-start gap-3">
                        <Video className="h-4 w-4 text-[oklch(0.72_0.15_85)] mt-0.5 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-sm truncate">{title}</p>
                          {date && (
                            <p className="text-xs text-muted-foreground mt-0.5">{date}</p>
                          )}
                          {summary && (
                            <p className="text-xs text-muted-foreground mt-1 line-clamp-3">
                              {summary}
                            </p>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
