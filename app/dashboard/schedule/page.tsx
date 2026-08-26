"use client";

import { useState, useEffect, useCallback } from "react";
import { getTodayISO } from "@/lib/timezone";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePersistentDraft } from "@/lib/hooks/use-persistent-draft";
import {
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  Send,
  Loader2,
  Clock,
  Users,
  Unplug,
  Check,
  X,
  Pencil,
  Save,
  Plus,
} from "lucide-react";
import Link from "next/link";
import { DayView, type DayEvent } from "./components/DayView";
import { NewEventDialog } from "./components/NewEventDialog";

interface CalEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  isAllDay?: boolean;
  hasVideo?: boolean;
  attendees?: string[];
  dateLabel?: string;
  location?: string;
  description?: string;
  videoLink?: string;
  isOrganizer?: boolean;
  myResponseStatus?: "accepted" | "declined" | "tentative" | "needsAction";
}

interface ProposedMeeting {
  title: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:MM
  duration: number;
  attendees: string[];
  status: "proposed" | "approved" | "declined";
}

interface ScheduleDraft {
  proposed: ProposedMeeting[];
  basilResponse: string;
}

const EMPTY_SCHEDULE_DRAFT: ScheduleDraft = {
  proposed: [],
  basilResponse: "",
};

function toDay(e: CalEvent): DayEvent {
  return {
    id: e.id,
    summary: e.summary,
    start: e.start,
    end: e.end,
    isAllDay: !!e.isAllDay,
    hasVideo: !!e.hasVideo,
    attendees: e.attendees || [],
    location: e.location,
    description: e.description,
    videoLink: e.videoLink,
    isOrganizer: e.isOrganizer,
    myResponseStatus: e.myResponseStatus,
  };
}

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfWeek(year: number, month: number) {
  return new Date(year, month, 1).getDay(); // 0=Sun
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function SchedulePage() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [selectedDay, setSelectedDay] = useState<number | null>(now.getDate());
  const [newEventOpen, setNewEventOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [basilInput, setBasilInput] = useState("");
  const [basilLoading, setBasilLoading] = useState(false);
  const [approving, setApproving] = useState<number | null>(null);
  // Proposed meeting inline editing
  const [editProposedIdx, setEditProposedIdx] = useState<number | null>(null);
  const [editProposedForm, setEditProposedForm] = useState<{
    title: string; date: string; startTime: string; duration: number;
  }>({ title: "", date: "", startTime: "09:00", duration: 30 });

  // CLASSIFICATION: disposable UX state — Basil's scheduling proposals for
  // the current device session.  Proposals that the user approves are written
  // to Google Calendar (the durable truth); the localStorage copy is only a
  // pending-queue display aid.  Clearing this key loses unsent proposals, not
  // committed calendar events.
  const {
    draft: scheduleDraft,
    setDraft: setScheduleDraft,
  } = usePersistentDraft<ScheduleDraft>("sage-schedule-v1", {
    defaultValue: EMPTY_SCHEDULE_DRAFT,
  });

  const proposed = scheduleDraft.proposed;
  const basilResponse = scheduleDraft.basilResponse;

  const setProposed = (
    updater: ProposedMeeting[] | ((prev: ProposedMeeting[]) => ProposedMeeting[])
  ) => {
    setScheduleDraft((d) => ({
      ...d,
      proposed: typeof updater === "function" ? updater(d.proposed) : updater,
    }));
  };

  const setBasilResponse = (v: string) => {
    setScheduleDraft((d) => ({ ...d, basilResponse: v }));
  };

  // Drop proposals whose date has already passed on first render.
  useEffect(() => {
    const today = getTodayISO(); // uses Europe/London default — correct for Michael
    setScheduleDraft((d) => {
      const fresh = d.proposed.filter((p) => p.date >= today);
      if (fresh.length === d.proposed.length) return d; // no change
      return { ...d, proposed: fresh };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch events for the visible month
  const fetchEvents = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/calendar/month?year=${year}&month=${month}`)
      .then((r) => { if (!r.ok) throw new Error(`calendar ${r.status}`); return r.json(); })
      .then((d) => {
        setConnected(d.connected);
        setEvents(d.events || []);
        setLoading(false);
      })
      // Previously swallowed → an empty calendar that looked like "no events"
      // rather than a failed load.
      .catch((e: unknown) => { setError(e instanceof Error ? e : new Error("Failed to load calendar")); setLoading(false); });
  }, [year, month]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  // Events grouped by day number
  const eventsByDay: Record<number, CalEvent[]> = {};
  for (const e of events) {
    const dateStr = (e.start || "").substring(0, 10);
    const eventDate = new Date(dateStr + "T12:00:00");
    if (eventDate.getFullYear() === year && eventDate.getMonth() === month) {
      const day = eventDate.getDate();
      if (!eventsByDay[day]) eventsByDay[day] = [];
      eventsByDay[day].push(e);
    }
  }

  // Proposed meetings grouped by day number
  const proposedByDay: Record<number, ProposedMeeting[]> = {};
  for (const p of proposed) {
    if (p.status === "declined") continue;
    const pDate = new Date(p.date + "T12:00:00");
    if (pDate.getFullYear() === year && pDate.getMonth() === month) {
      const day = pDate.getDate();
      if (!proposedByDay[day]) proposedByDay[day] = [];
      proposedByDay[day].push(p);
    }
  }

  const daysInMonth = getDaysInMonth(year, month);
  const firstDay = getFirstDayOfWeek(year, month);
  // Use timezone-aware today to correctly highlight the current day
  const todayISO = getTodayISO();
  const [todayYear, todayMonth0, todayDate] = todayISO.split("-").map(Number) as [number, number, number];
  const todayDay =
    todayYear === year && (todayMonth0 - 1) === month ? todayDate : -1;

  const selectedEvents = selectedDay ? eventsByDay[selectedDay] || [] : [];
  const selectedDateStr = selectedDay
    ? `${year}-${String(month + 1).padStart(2, "0")}-${String(selectedDay).padStart(2, "0")}`
    : "";
  const selectedProposed = proposed.filter(
    (p) => p.date === selectedDateStr && p.status !== "declined"
  );

  function prevMonth() {
    if (month === 0) {
      setYear(year - 1);
      setMonth(11);
    } else {
      setMonth(month - 1);
    }
    setSelectedDay(null);
  }

  function nextMonth() {
    if (month === 11) {
      setYear(year + 1);
      setMonth(0);
    } else {
      setMonth(month + 1);
    }
    setSelectedDay(null);
  }

  function startEditProposed(index: number) {
    const p = proposed[index];
    if (!p) return;
    setEditProposedIdx(index);
    setEditProposedForm({ title: p.title, date: p.date, startTime: p.startTime, duration: p.duration });
  }

  function saveEditProposed() {
    if (editProposedIdx === null) return;
    setProposed((prev) =>
      prev.map((p, i) =>
        i === editProposedIdx
          ? { ...p, ...editProposedForm }
          : p
      )
    );
    setEditProposedIdx(null);
  }

  async function handleApprove(index: number) {
    const meeting = proposed[index];
    if (!meeting || meeting.status !== "proposed") return;

    setApproving(index);
    try {
      const res = await fetch("/api/calendar/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: meeting.title,
          attendees: meeting.attendees,
          date: meeting.date,
          startTime: meeting.startTime,
          duration: meeting.duration,
        }),
      });

      const data = await res.json();
      if (data.success) {
        setProposed((prev) =>
          prev.map((p, i) => (i === index ? { ...p, status: "approved" as const } : p))
        );
        // Refetch calendar events to show the newly created one
        fetchEvents();
      } else {
        setBasilResponse(`Failed to create event: ${data.error || "Unknown error"}`);
      }
    } catch {
      setBasilResponse("Failed to reach calendar API.");
    } finally {
      setApproving(null);
    }
  }

  function handleDecline(index: number) {
    setProposed((prev) =>
      prev.map((p, i) => (i === index ? { ...p, status: "declined" as const } : p))
    );
  }

  async function handleBasilSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!basilInput.trim()) return;
    setBasilLoading(true);
    setBasilResponse("");

    // We POST to /api/chat with a one-off message. The scheduleMeeting tool
    // has needsApproval=true so the AI SDK emits a `tool-input-available`
    // event without executing — we render our own approval card here and call
    // /api/calendar/create on approve. No state is shared with the Chat tab's
    // useChat() instance, so there's no double-approval path.
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            {
              id: "schedule-" + Date.now(),
              role: "user",
              parts: [{ type: "text", text: basilInput }],
              createdAt: new Date(),
            },
          ],
        }),
      });

      // Read the SSE stream from toUIMessageStreamResponse (AI SDK v6 format)
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response stream");

      const decoder = new TextDecoder();
      let buffer = "";
      let foundProposal = false;
      let assistantText = "";

      // Each SSE line is `data: <json>\n\n`. Tool calls arrive as
      // {type:"tool-input-available", toolName, input:{...}} and text deltas as
      // {type:"text-delta", delta} / {type:"text", text}.
      const handleEvent = (json: string) => {
        try {
          const evt = JSON.parse(json);
          if (evt.type === "tool-input-available" && evt.toolName === "scheduleMeeting") {
            const input = evt.input || {};
            const newProposed: ProposedMeeting = {
              title: input.title || "Untitled Meeting",
              date: input.date || "",
              startTime: input.startTime || "09:00",
              duration: input.duration || 30,
              attendees: input.attendees || [],
              status: "proposed",
            };
            setProposed((prev) => [...prev, newProposed]);
            foundProposal = true;
            const pDate = new Date(newProposed.date + "T12:00:00");
            if (pDate.getFullYear() === year && pDate.getMonth() === month) {
              setSelectedDay(pDate.getDate());
            }
          } else if (evt.type === "text-delta" && typeof evt.delta === "string") {
            assistantText += evt.delta;
          } else if (evt.type === "text" && typeof evt.text === "string") {
            assistantText += evt.text;
          }
        } catch {
          /* ignore unparseable chunks */
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Drain complete SSE messages (double-newline separated)
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of block.split("\n")) {
            if (line.startsWith("data: ")) {
              const payload = line.slice(6).trim();
              if (payload && payload !== "[DONE]") handleEvent(payload);
            }
          }
        }
      }

      if (foundProposal) {
        setBasilResponse(
          "Basil proposed a meeting. Review it on the calendar and approve or decline."
        );
      } else if (assistantText.trim()) {
        setBasilResponse(assistantText.trim().slice(0, 400));
      } else {
        setBasilResponse(
          "Basil didn't propose a meeting. Try being more specific — include the person, date, and time."
        );
      }
    } catch {
      setBasilResponse("Failed to reach Basil. Try the Chat tab directly.");
    } finally {
      setBasilLoading(false);
      setBasilInput("");
    }
  }

  // ── Today navigation helper ─────────────────────────────────────────────────
  function goToToday() {
    setYear(now.getFullYear());
    setMonth(now.getMonth());
    setSelectedDay(now.getDate());
  }

  // ── Formatted selected day label ────────────────────────────────────────────
  const selectedDateLabel = selectedDay
    ? `${DAY_NAMES[new Date(`${year}-${String(month + 1).padStart(2, "0")}-${String(selectedDay).padStart(2, "0")}T12:00:00`).getDay()]}, ${MONTH_NAMES[month]} ${selectedDay}`
    : "";

  const pendingProposals = proposed.map((p, i) => ({ ...p, _index: i })).filter((p) => p.status === "proposed");

  // Prefill the New Event form with the day the user has selected (or today).
  const selectedDateISO = selectedDay
    ? `${year}-${String(month + 1).padStart(2, "0")}-${String(selectedDay).padStart(2, "0")}`
    : getTodayISO();

  return (
    <div className="wire h-full flex flex-col overflow-hidden">
      <NewEventDialog
        open={newEventOpen}
        onOpenChange={setNewEventOpen}
        defaultDate={selectedDateISO}
        onCreated={({ title, attendeeCount }) => {
          fetchEvents();
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
      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 min-h-12 border-b border-border/40 shrink-0 bg-background/80 backdrop-blur-sm">
        <CalendarPlus className="h-4 w-4 text-[color:var(--w-carbon)] shrink-0" />
        <span className="font-semibold text-sm">Schedule</span>

        <Button
          size="sm"
          className="h-7 gap-1.5 ml-1"
          onClick={() => setNewEventOpen(true)}
        >
          <Plus className="h-3.5 w-3.5" /> New event
        </Button>

        <div className="flex-1" />

        {/* Month navigation */}
        <div className="flex items-center gap-1">
          <button
            onClick={prevMonth}
            className="p-1.5 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
            aria-label="Previous month"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span className="text-sm font-medium w-28 text-center">
            {MONTH_NAMES[month]} {year}
          </span>
          <button
            onClick={nextMonth}
            className="p-1.5 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
            aria-label="Next month"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>

        <button
          onClick={goToToday}
          className="px-3 py-1 text-xs font-medium rounded-md border border-border hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
        >
          Today
        </button>

        {error && !loading ? (
          <button
            onClick={fetchEvents}
            className="flex items-center gap-1.5 text-xs text-signal-critical bg-signal-critical-subtle border border-signal-critical-border/60 px-2.5 py-1 rounded-md hover:opacity-90 transition-opacity"
          >
            <Unplug className="h-3 w-3" /> Couldn&apos;t load calendar — retry
          </button>
        ) : !connected && !loading ? (
          <Link
            href="/dashboard/settings"
            className="flex items-center gap-1.5 text-xs text-signal-warning bg-signal-warning-subtle border border-signal-warning-border/60 px-2.5 py-1 rounded-md hover:bg-signal-warning-subtle transition-colors"
          >
            <Unplug className="h-3 w-3" /> Calendar not connected
          </Link>
        ) : null}
      </div>

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-col md:flex-row flex-1 min-h-0 overflow-y-auto md:overflow-hidden">

        {/* ── Left sidebar ─────────────────────────────────────────────── */}
        <aside className="w-full md:w-60 border-b md:border-b-0 md:border-r border-border/40 flex flex-col overflow-hidden shrink-0 bg-sidebar/20">

          {/* Mini calendar */}
          <div className="p-3 shrink-0">
            {/* Day-name row */}
            <div className="grid grid-cols-7 gap-0.5 mb-1">
              {["S","M","T","W","T","F","S"].map((d, i) => (
                <div key={i} className="text-center text-xs font-semibold text-muted-foreground/60 py-0.5">
                  {d}
                </div>
              ))}
            </div>
            {/* Day cells */}
            {loading ? (
              <Skeleton className="h-32 w-full rounded-md" />
            ) : (
              <div className="grid grid-cols-7 gap-0.5">
                {Array.from({ length: firstDay }).map((_, i) => (
                  <div key={`e-${i}`} className="h-7" />
                ))}
                {Array.from({ length: daysInMonth }).map((_, i) => {
                  const day = i + 1;
                  const isToday = day === todayDay;
                  const isSelected = day === selectedDay;
                  const hasCal = (eventsByDay[day] || []).filter((e) => !e.isAllDay).length > 0;
                  const hasProp = (proposedByDay[day] || []).some((p) => p.status === "proposed");

                  return (
                    <button
                      key={day}
                      onClick={() => setSelectedDay(day)}
                      className={`h-7 w-full rounded flex flex-col items-center justify-center text-xs font-medium relative transition-colors
                        ${isSelected
                          ? "bg-[var(--w-carbon)] text-[oklch(0.18_0.04_250)]"
                          : isToday
                            ? "ring-1 ring-[var(--w-carbon)] text-[color:var(--w-carbon)] font-bold"
                            : "text-foreground hover:bg-accent/50"
                        }`}
                    >
                      {day}
                      {/* Event indicator dots */}
                      {(hasCal || hasProp) && !isSelected && (
                        <div className="flex gap-0.5 absolute bottom-0.5">
                          {hasCal && <span className="w-1 h-1 rounded-full bg-[var(--w-carbon-tint)]" />}
                          {hasProp && <span className="w-1 h-1 rounded-full bg-signal-warning" />}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Selected day agenda list */}
          <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-2">
            {selectedDay ? (
              <>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 sticky top-0 bg-sidebar/20 py-1">
                  {selectedDateLabel}
                </p>
                {selectedEvents.filter((e) => !e.isAllDay).length === 0 ? (
                  <p className="text-xs text-muted-foreground/50 italic py-1">No events</p>
                ) : (
                  <div className="space-y-0.5">
                    {selectedEvents
                      .filter((e) => !e.isAllDay)
                      .map((ev, i) => {
                        const t = new Date(ev.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                        return (
                          <div key={i} className="flex items-start gap-2 py-1.5 border-b border-border/25 last:border-0">
                            <span className="text-xs font-mono text-muted-foreground/60 mt-0.5 w-10 shrink-0">{t}</span>
                            <div className="flex-1 min-w-0">
                              <p className="text-xs leading-snug truncate font-medium">{ev.summary}</p>
                              {ev.hasVideo && (
                                <span className="text-xs text-[oklch(0.55_0.15_85)]">Video call</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                  </div>
                )}
                {/* Proposed for this day */}
                {selectedProposed.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-signal-warning-border/30">
                    <p className="text-xs font-semibold uppercase tracking-wider text-signal-warning mb-1.5">
                      Proposed ({selectedProposed.length})
                    </p>
                    {selectedProposed.map((p, i) => {
                      const globalIndex = proposed.indexOf(p);
                      return (
                        <div key={i} className="rounded-md p-2 mb-1.5 bg-signal-warning-subtle border border-dashed border-signal-warning-border/40">
                          <p className="text-xs font-medium truncate">{p.title}</p>
                          <p className="text-xs text-muted-foreground">{p.startTime} · {p.duration}min</p>
                          <div className="flex gap-1.5 mt-1.5">
                            <button
                              disabled={approving === globalIndex}
                              onClick={() => handleApprove(globalIndex)}
                              className="flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded bg-signal-positive text-white hover:bg-signal-positive disabled:opacity-50 transition-colors"
                            >
                              {approving === globalIndex ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Check className="h-2.5 w-2.5" />}
                              Approve
                            </button>
                            <button
                              onClick={() => handleDecline(globalIndex)}
                              className="text-xs font-medium px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-destructive hover:border-destructive/40 transition-colors"
                            >
                              Decline
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            ) : (
              <p className="text-xs text-muted-foreground/40 italic py-2">Pick a day</p>
            )}
          </div>

          {/* Pending proposals (global) — if any outside selected day */}
          {pendingProposals.filter((p) => p.date !== selectedDateStr).length > 0 && (
            <div className="border-t border-signal-warning-border/30 px-3 py-2 shrink-0">
              <p className="text-xs font-semibold uppercase tracking-wider text-signal-warning mb-1.5">
                Other pending ({pendingProposals.filter((p) => p.date !== selectedDateStr).length})
              </p>
              <div className="space-y-1 max-h-24 overflow-y-auto">
                {pendingProposals
                  .filter((p) => p.date !== selectedDateStr)
                  .map((p) => (
                    <div key={p._index} className="text-xs text-muted-foreground flex items-center gap-1.5 cursor-pointer hover:text-foreground" onClick={() => {
                      const d = new Date(p.date + "T12:00:00");
                      setYear(d.getFullYear()); setMonth(d.getMonth()); setSelectedDay(d.getDate());
                    }}>
                      <span className="w-1.5 h-1.5 rounded-full bg-signal-warning shrink-0" />
                      <span className="truncate">{p.date} — {p.title}</span>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* Ask Basil */}
          <div className="border-t border-border/40 p-3 shrink-0">
            <div className="flex items-center gap-1.5 mb-2">
              <img src="/brand/basil-mark.png" alt="" className="h-3.5 w-3.5 rounded" />
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Ask Basil</span>
            </div>
            {/* Pre-populated scheduling prompts — clicking submits immediately.
                Calendar-flavoured so suggestions are relevant to this surface. */}
            {!basilInput && !basilLoading && (
              <div className="flex flex-wrap gap-1 mb-2">
                {[
                  "Schedule a 30 min with Sam tomorrow",
                  "Find a 1h slot this week",
                  "Block 2h for focus tomorrow morning",
                  "When am I free Friday?",
                ].map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => {
                      setBasilInput(q);
                      // Submit on the next tick once state has flushed.
                      requestAnimationFrame(() => {
                        const form = document.getElementById("schedule-basil-form") as HTMLFormElement | null;
                        form?.requestSubmit();
                      });
                    }}
                    className="text-xs px-2 py-1 rounded-md border border-[var(--w-rule)] bg-[var(--w-carbon-tint)] text-[oklch(0.55_0.12_85)] hover:bg-[var(--w-carbon-tint)] transition-colors text-left leading-tight"
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}

            <form id="schedule-basil-form" onSubmit={handleBasilSubmit} className="space-y-2">
              <Textarea
                value={basilInput}
                onChange={(e) => setBasilInput(e.target.value)}
                placeholder="Or type your own request…"
                className="min-h-[56px] resize-none text-xs leading-relaxed"
                rows={2}
              />
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground leading-snug">You approve before any invite sends</p>
                <Button
                  type="submit"
                  size="sm"
                  disabled={basilLoading || !basilInput.trim()}
                  className="h-6 text-xs shrink-0 bg-[var(--w-carbon)] text-[oklch(0.18_0.04_250)] hover:bg-[oklch(0.78_0.12_85)] gap-1 px-2"
                >
                  {basilLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                  Send
                </Button>
              </div>
            </form>
            {basilResponse && (
              <p className="mt-2 text-xs text-muted-foreground bg-accent/30 rounded px-2 py-1.5 leading-relaxed">
                {basilResponse}
              </p>
            )}
          </div>
        </aside>

        {/* ── Main: full-width DayView ────────────────────────────────── */}
        <main className="flex-1 min-w-0 flex flex-col overflow-hidden min-h-[70vh] md:min-h-0">
          {/* Day header bar */}
          <div className="flex items-center justify-between px-4 h-10 border-b border-border/40 shrink-0 bg-background/60">
            <div className="flex items-center gap-3">
              <span className="font-semibold text-sm">
                {selectedDateLabel || "No day selected"}
              </span>
              {selectedDay && (
                <span className="text-xs text-muted-foreground">
                  {selectedEvents.filter((e) => !e.isAllDay).length} event
                  {selectedEvents.filter((e) => !e.isAllDay).length !== 1 ? "s" : ""}
                </span>
              )}
            </div>
            {!connected && (
              <span className="text-xs text-muted-foreground/50">Connect Google Calendar to see events</span>
            )}
          </div>

          {/* DayView — fills all remaining height, no fixed cap */}
          <div className="flex-1 min-h-0 overflow-hidden">
            {selectedDay ? (
              <DayView
                date={selectedDateStr}
                events={selectedEvents.filter((e) => !e.isAllDay).map(toDay)}
                onRefresh={fetchEvents}
              />
            ) : (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground/40">
                <CalendarPlus className="h-10 w-10" />
                <p className="text-sm">Select a day from the mini calendar</p>
              </div>
            )}
          </div>
        </main>

      </div>
    </div>
  );
}

