"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import { DataState } from "@/components/ui/data-state";
import { NewEventDialog } from "@/app/dashboard/schedule/components/NewEventDialog";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  CalendarCheck,
  Video,
  Users,
  ChevronDown,
  ChevronUp,
  Plus,
  Sparkles,
  Unplug,
  Search,
  Check,
} from "lucide-react";
import { formatTime, cn } from "@/lib/utils";
import Link from "next/link";

// ── Types ──────────────────────────────────────────────────────────────────────

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

/**
 * Is this calendar block worth prepping?
 *
 * Only if other PEOPLE are involved — real attendees, or a video link. Your
 * calendar is full of solo blocks (Focus time, Lunch, Decompress) which came
 * through here as ordinary events and each got a gold "Prep" CTA linking to an
 * AI prep cheatsheet. Offering to brief you on your lunch is noise, and the
 * destination was a dead end.
 */
function isPrepWorthy(event: CalEvent): boolean {
  return Boolean(event.hasVideo)
    || (event.attendees?.length ?? 0) > 0
    || (event.attendeeCount ?? 0) > 1;
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

interface PastMeetingMemory {
  id: string;
  content: string;
  entity?: string;
  createdAt?: string;
  sourceRef?: string;
  eventId?: string;
}

// ── Meeting picker (calendar-linked) ─────────────────────────────────────────

/**
 * When calendar is connected, lets the user jump directly to any upcoming
 * meeting's prep page without scrolling through the grouped list.
 */
function CalendarMeetingPicker({ events }: { events: CalEvent[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (!query.trim()) return events;
    const q = query.toLowerCase();
    return events.filter(
      (e) =>
        e.summary.toLowerCase().includes(q) ||
        (e.attendees ?? []).some((a) => a.toLowerCase().includes(q)) ||
        (e.dateLabel ?? "").toLowerCase().includes(q)
    );
  }, [events, query]);

  return (
    <div className="mb-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-sm font-medium text-gold hover:underline"
      >
        <Search className="h-4 w-4" />
        Prep a specific meeting
        {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>

      {open && (
        <Card className="mt-3 border-gold/30">
          <CardContent className="p-4 space-y-3">
            <p className="text-xs text-muted-foreground">
              Select any upcoming calendar event to generate a prep cheatsheet.
            </p>

            {/* Search */}
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by title, attendee, or day…"
              autoFocus
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-gold/40"
            />

            {/* Event list */}
            <div className="max-h-72 overflow-y-auto space-y-1.5 pr-1">
              {filtered.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2 text-center">No meetings match.</p>
              ) : (
                filtered.map((event) => (
                  <button
                    key={event.id}
                    onClick={() => router.push(`/dashboard/meetings/${event.id}`)}
                    className="w-full flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent/50 transition-colors"
                  >
                    {/* Time block */}
                    <div className="flex flex-col items-center justify-center rounded bg-muted px-2 py-1 min-w-[60px] text-center shrink-0">
                      <span className="text-xs font-mono font-medium">{formatTime(event.start)}</span>
                      {event.dateLabel && (
                        <span className="text-xs text-muted-foreground leading-tight">
                          {event.dateLabel === "Today" || event.dateLabel === "Tomorrow"
                            ? event.dateLabel
                            : event.dateLabel.split(",")[0]}
                        </span>
                      )}
                    </div>

                    {/* Title + attendees */}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{event.summary}</p>
                      {event.attendees && event.attendees.length > 0 && (
                        <p className="text-xs text-muted-foreground truncate">
                          {event.attendees.slice(0, 3).join(", ")}
                          {event.attendees.length > 3 ? ` +${event.attendees.length - 3}` : ""}
                        </p>
                      )}
                    </div>

                    {/* Indicators */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      {event.hasVideo && <Video className="h-3.5 w-3.5 text-muted-foreground" />}
                      <Sparkles className="h-3.5 w-3.5 text-gold" />
                    </div>
                  </button>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── Manual prep form (fallback when not connected) ────────────────────────────

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
        className="flex items-center gap-2 text-sm font-medium text-gold hover:underline"
      >
        <Plus className="h-4 w-4" />
        Manual meeting note
        {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>

      {open && (
        <Card className="mt-3 border-gold/30">
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
                  className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-gold/40"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Date &amp; time</label>
                <input
                  required
                  type="datetime-local"
                  value={form.datetime}
                  onChange={(e) => setForm((f) => ({ ...f, datetime: e.target.value }))}
                  className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-gold/40"
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
                  className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-gold/40"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Context / notes</label>
                <textarea
                  value={form.context}
                  onChange={(e) => setForm((f) => ({ ...f, context: e.target.value }))}
                  placeholder="Background, open questions, relevant history…"
                  rows={3}
                  className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-gold/40 resize-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Desired outcome</label>
                <input
                  type="text"
                  value={form.outcome}
                  onChange={(e) => setForm((f) => ({ ...f, outcome: e.target.value }))}
                  placeholder="e.g. Agree on Q3 budget"
                  className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-gold/40"
                />
              </div>
              <div className="flex gap-2 pt-1">
                <Button type="submit" size="sm" disabled={saving}>
                  {saving ? "Saving…" : "Save note"}
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
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
        Saved notes
      </h3>
      {preps.map((prep) => (
        <Card key={prep.id} className="border-border/60">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <CalendarCheck className="h-4 w-4 text-gold mt-0.5 shrink-0" />
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

// ── Past meeting memory helpers ───────────────────────────────────────────────

/**
 * Pulls structured fields out of a free-text meeting memory.
 *
 * Memory content typically follows one of two patterns:
 *   1. `[Zoom meeting — TOPIC] YYYY-MM-DD. Attendees: a, b. Summary…`  (direct Zoom API)
 *   2. `Topic plain text. Attendees: a, b. Summary…`                   (Gmail-detected)
 *
 * Best-effort: returns sensible defaults rather than throwing.
 */
function parseMeetingMemory(content: string): {
  title: string;
  summary: string;
  date: string;
  attendees: string[];
} {
  const bracketMatch = content.match(/\[(?:Zoom meeting\s*[—–-]\s*)?([^\]]+)\]/);
  const dateMatch = content.match(/\d{4}-\d{2}-\d{2}/);
  const attendeesMatch = content.match(/Attendees:\s*([^.]+?)\./i);

  // Title: bracketed topic > first sentence before "Topics covered" > first 60 chars.
  let title: string;
  if (bracketMatch) {
    title = bracketMatch[1].trim();
  } else {
    const firstSentence = content.split(/[.:]/)[0]?.trim() ?? "";
    title = firstSentence && firstSentence.length < 80
      ? firstSentence
      : content.slice(0, 60).trim() + (content.length > 60 ? "…" : "");
  }

  const attendees = attendeesMatch
    ? attendeesMatch[1]
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s && s.toLowerCase() !== "none listed" && s.toLowerCase() !== "unknown")
    : [];

  // Summary: strip the bracket header, the Attendees clause, and any leading
  // date so the body reads cleanly as the meeting recap.
  const summary = content
    .replace(/\[[^\]]+\]/, "")
    .replace(/Attendees:\s*[^.]+\.\s*/i, "")
    .replace(/^\s*\d{4}-\d{2}-\d{2}\.\s*/, "")
    .trim();

  return {
    title,
    summary,
    date: dateMatch ? dateMatch[0] : "",
    attendees,
  };
}

/** Format an ISO timestamp as "12 Apr · 14:30" for compact display. */
function formatIngested(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Format a YYYY-MM-DD date as a readable day label. */
function formatMeetingDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso + "T12:00:00");
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function MeetingsPage() {
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [manualPreps, setManualPreps] = useState<ManualPrep[]>([]);
  const [pastMeetings, setPastMeetings] = useState<PastMeetingMemory[]>([]);
  const [pastLoading, setPastLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch("/api/calendar/upcoming")
      .then((r) => { if (!r.ok) throw new Error(`calendar ${r.status}`); return r.json(); })
      .then((d) => {
        setConnected(d.connected);
        setEvents((d.events || []).filter((e: CalEvent) => !e.isAllDay));
        setLoading(false);
      })
      // A failed fetch previously fell through to the "not connected" panel —
      // wrongly telling the user to reconnect Google when the request just failed.
      .catch((e: unknown) => { setError(e instanceof Error ? e : new Error("Failed to load calendar")); setLoading(false); });

    fetch("/api/memory/recent-meetings")
      .then((r) => r.json())
      .then((d) => {
        setPastMeetings(d.memories || []);
        setPastLoading(false);
      })
      .catch(() => setPastLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Group events by dateLabel
  const grouped: Record<string, CalEvent[]> = {};
  for (const e of events) {
    const label = e.dateLabel || "Other";
    if (!grouped[label]) grouped[label] = [];
    grouped[label].push(e);
  }
  const dayOrder = Object.keys(grouped);

  // Build a human-readable range label for the subtitle (e.g. "7 days" / "14 days")
  const daySpan = events.length > 0
    ? Math.ceil(
        (new Date(events[events.length - 1].start).getTime() - Date.now()) / 86_400_000
      )
    : 14;
  const rangeLabel = daySpan <= 2 ? "today & tomorrow" : `next ${Math.min(daySpan + 1, 14)} days`;

  const handleManualSaved = (prep: ManualPrep) => {
    setManualPreps((prev) => [prep, ...prev]);
  };

  // Tab state — defaults to upcoming. Past intelligence is the second tab.
  const [activeTab, setActiveTab] = useState<"upcoming" | "past">("upcoming");
  const [newEventOpen, setNewEventOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 pb-8">
      <NewEventDialog
        open={newEventOpen}
        onOpenChange={setNewEventOpen}
        onCreated={({ title, attendeeCount }) => {
          load();
          setToast(
            attendeeCount > 0
              ? `Created "${title}" — invite${attendeeCount === 1 ? "" : "s"} sent to ${attendeeCount} ${attendeeCount === 1 ? "person" : "people"}.`
              : `Created "${title}".`,
          );
          setTimeout(() => setToast(null), 5000);
        }}
      />
      {toast && (
        <div className="fixed bottom-5 right-5 z-50 max-w-sm rounded-lg border border-signal-positive-border bg-signal-positive-subtle px-4 py-2.5 text-sm text-signal-positive shadow-lg flex items-start gap-2">
          <Check className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{toast}</span>
        </div>
      )}
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <CalendarCheck className="h-6 w-6 text-gold" />
            Meeting Prep
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {activeTab === "upcoming"
              ? connected
                ? `Showing ${rangeLabel}. Click any meeting to generate a prep cheatsheet.`
                : "Connect Google Calendar to see upcoming meetings."
              : "Recaps of meetings Basil has analysed."}
          </p>
        </div>
        <Button size="sm" className="gap-1.5 shrink-0" onClick={() => setNewEventOpen(true)}>
          <Plus className="h-3.5 w-3.5" /> New event
        </Button>
      </header>

      {/* ── Tab strip ─────────────────────────────────────────────────────── */}
      <div className="border-b border-border/60 -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8">
        <div className="flex gap-1 -mb-px">
          {([
            { id: "upcoming", label: "Upcoming meetings", count: events.length },
            { id: "past",     label: "Past intelligence",  count: pastMeetings.length },
          ] as const).map((tab) => {
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`relative flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors
                  ${active
                    ? "text-gold"
                    : "text-muted-foreground hover:text-foreground"}`}
              >
                {tab.label}
                {tab.count > 0 && (
                  <span className={`inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-xs font-semibold
                    ${active
                      ? "bg-gold/15 text-[oklch(0.55_0.12_85)]"
                      : "bg-muted text-muted-foreground"}`}>
                    {tab.count}
                  </span>
                )}
                {active && (
                  <span className="absolute -bottom-px left-2 right-2 h-0.5 rounded-t-full bg-gold" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── PAST INTELLIGENCE TAB ───────────────────────────────────────── */}
      {activeTab === "past" && (
        <div>
          {pastLoading ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <Card key={i}>
                  <CardContent className="p-4">
                    <Skeleton className="h-4 w-2/3 mb-2" />
                    <Skeleton className="h-3 w-full" />
                    <Skeleton className="h-3 w-3/4 mt-1" />
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : pastMeetings.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <Video className="h-10 w-10 mx-auto text-muted-foreground/30 mb-2" />
                <p className="text-muted-foreground">No past meeting intelligence yet.</p>
                <p className="text-xs text-muted-foreground/70 mt-1">
                  Basil surfaces recaps automatically when Zoom emails arrive.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {pastMeetings.map((mem) => {
                const { title, summary, date, attendees } = parseMeetingMemory(mem.content);
                const meetingDate = date ? formatMeetingDate(date) : "";
                const ingested = formatIngested(mem.createdAt);
                return (
                  <Card key={mem.id} className="border-border/60 hover:border-border transition-colors">
                    <CardContent className="p-4">
                      <div className="flex items-start gap-3">
                        <Video className="h-4 w-4 text-gold mt-1 shrink-0" />
                        <div className="min-w-0 flex-1 space-y-2">
                          {/* Title row */}
                          <p className="font-medium text-sm leading-snug">{title}</p>

                          {/* Date / time row */}
                          {(meetingDate || ingested) && (
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                              {meetingDate && (
                                <span className="inline-flex items-center gap-1">
                                  <CalendarCheck className="h-3 w-3" />
                                  {meetingDate}
                                </span>
                              )}
                              {ingested && (
                                <span className="inline-flex items-center gap-1 text-muted-foreground/70">
                                  · captured {ingested}
                                </span>
                              )}
                            </div>
                          )}

                          {/* Attendees pills */}
                          {attendees.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Users className="h-3 w-3 text-muted-foreground/70" />
                              {attendees.slice(0, 6).map((name, i) => (
                                <span
                                  key={i}
                                  className="inline-block rounded-full bg-muted/60 px-2 py-0.5 text-xs text-foreground/80"
                                >
                                  {name}
                                </span>
                              ))}
                              {attendees.length > 6 && (
                                <span className="text-xs text-muted-foreground">
                                  +{attendees.length - 6} more
                                </span>
                              )}
                            </div>
                          )}

                          {/* Summary */}
                          {summary && (
                            <p className="text-sm text-muted-foreground leading-relaxed line-clamp-4">
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

      {/* ── UPCOMING MEETINGS TAB ───────────────────────────────────────── */}
      {activeTab === "upcoming" && (loading ? (
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
      ) : error ? (
        /* ── Load failed (distinct from "not connected") ─────────────────────── */
        <DataState fill error={error} onRetry={load} />
      ) : !connected ? (
        /* ── Not connected ───────────────────────────────────────────────────── */
        <div className="space-y-6">
          <Card className="border-gold/30">
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
              Or save a manual meeting note:
            </p>
            <ManualPrepForm onSaved={handleManualSaved} />
            <ManualPrepList preps={manualPreps} />
          </div>
        </div>
      ) : (
        /* ── Connected ───────────────────────────────────────────────────────── */
        <div className="space-y-6">

          {/* Quick picker — jump to any meeting's prep page directly */}
          {events.length > 0 && <CalendarMeetingPicker events={events} />}

          {/* Grouped meeting list */}
          {events.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <p className="text-muted-foreground">No upcoming meetings in the next 14 days.</p>
              </CardContent>
            </Card>
          ) : (
            dayOrder.map((dayLabel) => (
              <div key={dayLabel}>
                <div className="flex items-center gap-2 mb-3">
                  <h2 className="text-sm font-bold uppercase tracking-wider text-gold">
                    {dayLabel}
                  </h2>
                  <div className="flex-1 h-px bg-border" />
                  <span className="text-xs text-muted-foreground">
                    {grouped[dayLabel].length} meeting
                    {grouped[dayLabel].length !== 1 ? "s" : ""}
                  </span>
                </div>

                <div className="space-y-3">
                  {grouped[dayLabel].map((event) => {
                    // Solo blocks (Focus time, Lunch, Decompress) still SHOW —
                    // they're your real day — but they don't pretend to be
                    // preppable: no gold CTA, and no link to a cheatsheet that
                    // would have nothing to say.
                    const preppable = isPrepWorthy(event);
                    const CardShell = (
                      <Card className={cn("mb-3 transition-colors", preppable && "cursor-pointer hover:bg-accent/30")}>
                        <CardContent className="p-4">
                          <div className="flex items-center gap-4">
                            {/* Time block */}
                            <div className="flex flex-col items-center justify-center rounded-lg bg-muted px-3 py-2 text-center min-w-[72px]">
                              <span className="text-sm font-mono font-medium">
                                {formatTime(event.start)}
                              </span>
                              <span className="text-xs text-muted-foreground font-mono">
                                {formatTime(event.end)}
                              </span>
                            </div>

                            {/* Title + meta */}
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

                            {/* Prep CTA — only when there's someone to prep for */}
                            {preppable && (
                              <div className="flex items-center gap-1.5 rounded-full bg-gold/10 text-[oklch(0.55_0.15_85)] px-3 py-1.5 text-xs font-semibold shrink-0 transition-colors hover:bg-gold/20">
                                <Sparkles className="h-3.5 w-3.5" />
                                Prep
                              </div>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    );
                    return preppable ? (
                      <Link key={event.id} href={`/dashboard/meetings/${event.id}`}>{CardShell}</Link>
                    ) : (
                      <div key={event.id}>{CardShell}</div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      ))}
      {/* end of UPCOMING TAB — closes `{activeTab === "upcoming" && (…)}` */}
    </div>
  );
}
