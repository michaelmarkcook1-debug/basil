"use client";

import { useState, useEffect, useCallback } from "react";
import { getTodayISO } from "@/lib/timezone";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { BTN_PRIMARY, BTN_SECONDARY } from "@/components/basil/page-hero";
import { usePersistentDraft } from "@/lib/hooks/use-persistent-draft";
import {
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  Send,
  Loader2,
  Unplug,
  Check,
  Plus,
} from "lucide-react";
import Link from "next/link";
import { DayView, type DayEvent } from "./components/DayView";
import { NewEventDialog } from "./components/NewEventDialog";
import { WeekPanel } from "./components/WeekLoad";
import { blockKind, KindLegend, KindSwatch } from "./components/event-kind";

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
  organizerName?: string;
  organizerEmail?: string;
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
    organizerName: e.organizerName,
    organizerEmail: e.organizerEmail,
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

  // ── "This week" panel inputs (presentation only — from the events already loaded) ──
  const monthPrefix = `${year}-${String(month + 1).padStart(2, "0")}`;
  const weekAnchorISO = selectedDay ? selectedDateStr : todayDay > 0 ? todayISO : `${monthPrefix}-01`;
  const weekStatus: "loading" | "error" | "disconnected" | "ready" =
    loading ? "loading" : error ? "error" : !connected ? "disconnected" : "ready";
  const selectedTimed = selectedEvents.filter((e) => !e.isAllDay);
  const otherPending = pendingProposals.filter((p) => p.date !== selectedDateStr);

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
        <div role="status" className="basil-pop fixed bottom-5 right-5 z-50 flex max-w-sm items-start gap-2.5 rounded-xl bg-[#10213F] px-4 py-3 text-[14px] text-[#F6F1E7] shadow-[0_16px_28px_-14px_rgba(16,33,63,.55)]">
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-[#D4B978]" />
          <span>{toast}</span>
        </div>
      )}

      {/* ── Header: compact tool-page title, month navigation, actions ──── */}
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2.5 border-b border-[var(--w-rule)] bg-[var(--w-paper)] px-4 py-3 sm:px-6">
        <h1 className="basil-serif text-[36px] leading-none tracking-[-0.02em] text-[#10213F]">
          Calendar<span className="text-[#C8A96B]">.</span>
        </h1>

        {/* Month navigation */}
        <nav aria-label="Month" className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={prevMonth}
            className={`${BTN_SECONDARY} w-11 px-0`}
            aria-label="Previous month"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span aria-live="polite" className="basil-serif min-w-[9.5rem] text-center text-[22px] leading-none text-[#10213F]">
            {MONTH_NAMES[month]} {year}
          </span>
          <button
            type="button"
            onClick={nextMonth}
            className={`${BTN_SECONDARY} w-11 px-0`}
            aria-label="Next month"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </nav>

        <button type="button" onClick={goToToday} className={BTN_SECONDARY}>
          Today
        </button>

        {/* Connection status */}
        {error && !loading ? (
          <button
            type="button"
            onClick={fetchEvents}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full border border-[var(--w-stamp)] bg-[var(--w-flimsy)] px-3 text-[13px] font-medium text-[color:var(--w-stamp)] transition-colors hover:bg-[var(--w-paper)]"
          >
            <Unplug className="h-3.5 w-3.5" /> Couldn&apos;t load calendar — retry
          </button>
        ) : !connected && !loading ? (
          <Link
            href="/dashboard/settings"
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full border border-[var(--w-manila)] bg-[var(--w-flimsy)] px-3 text-[13px] font-medium text-[color:var(--w-manila)] transition-colors hover:bg-[var(--w-paper)]"
          >
            <Unplug className="h-3.5 w-3.5" /> Calendar not connected
          </Link>
        ) : connected && !loading ? (
          <span className="inline-flex min-h-[36px] items-center gap-2 rounded-full border border-[var(--w-rule)] bg-[var(--w-flimsy)] px-3 text-[13px] text-[color:var(--w-ink-soft)]">
            <span aria-hidden className="h-2 w-2 rounded-full bg-[#1F8A70]" />
            Google Calendar connected
          </span>
        ) : null}

        <div className="flex-1" />

        <button type="button" className={BTN_PRIMARY} onClick={() => setNewEventOpen(true)}>
          <Plus className="h-4 w-4" /> New event
        </button>
      </header>

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-col md:flex-row flex-1 min-h-0 overflow-y-auto md:overflow-hidden">

        {/* ── Left panel ───────────────────────────────────────────────── */}
        <aside className="flex w-full shrink-0 flex-col gap-4 border-b border-[var(--w-rule)] bg-[var(--w-paper)] p-4 md:w-[300px] md:overflow-y-auto md:border-b-0 md:border-r">

          {/* Mini calendar */}
          <section aria-label={`${MONTH_NAMES[month]} ${year}`} className="basil-rise shrink-0 rounded-[20px] border border-[var(--w-rule)] bg-[var(--w-flimsy)] p-4">
            {/* Day-name row */}
            <div className="grid grid-cols-7 mb-1">
              {["S","M","T","W","T","F","S"].map((d, i) => (
                <div key={i} aria-hidden className="basil-mono py-1 text-center text-[11px] text-[color:var(--w-ink-soft)]">
                  {d}
                </div>
              ))}
            </div>
            {/* Day cells */}
            {loading ? (
              <Skeleton className="h-[200px] w-full rounded-xl bg-[var(--w-tray)]" />
            ) : (
              <div className="grid grid-cols-7 gap-y-1">
                {Array.from({ length: firstDay }).map((_, i) => (
                  <div key={`e-${i}`} className="h-8" />
                ))}
                {Array.from({ length: daysInMonth }).map((_, i) => {
                  const day = i + 1;
                  const isToday = day === todayDay;
                  const isSelected = day === selectedDay;
                  const calCount = (eventsByDay[day] || []).filter((e) => !e.isAllDay).length;
                  const hasCal = calCount > 0;
                  const hasProp = (proposedByDay[day] || []).some((p) => p.status === "proposed");

                  return (
                    <div key={day} className="flex justify-center">
                      <button
                        type="button"
                        onClick={() => setSelectedDay(day)}
                        aria-pressed={isSelected}
                        aria-label={`${MONTH_NAMES[month]} ${day}${isToday ? ", today" : ""}${hasCal ? `, ${calCount} event${calCount === 1 ? "" : "s"}` : ""}${hasProp ? ", proposal pending" : ""}`}
                        className={`relative flex h-8 w-8 items-center justify-center rounded-full text-[13px] transition-colors
                          ${isToday
                            ? "bg-[#10213F] font-semibold text-[#F6F1E7]"
                            : "text-[color:var(--w-ink)] hover:bg-[var(--w-tray)]"
                          }
                          ${isSelected ? "ring-2 ring-[#C8A96B] ring-offset-1 ring-offset-[var(--w-flimsy)]" : ""}`}
                      >
                        {day}
                        {/* Event indicator dots */}
                        {(hasCal || hasProp) && (
                          <span aria-hidden className="absolute bottom-[3px] flex gap-0.5">
                            {hasCal && <span className={`h-1 w-1 rounded-full ${isToday ? "bg-[#F6F1E7]" : "bg-[#10213F]"}`} />}
                            {hasProp && <span className={`h-1 w-1 rounded-full ${isToday ? "bg-[#D4B978]" : "bg-[var(--w-manila)]"}`} />}
                          </span>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[color:var(--w-ink-soft)]">
              <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#10213F]" />Events</span>
              <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--w-manila)]" />Basil proposal</span>
              <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-2.5 w-2.5 rounded-full ring-2 ring-[#C8A96B]" />Selected</span>
            </p>
          </section>

          {/* This week — meeting hours vs free, Mon–Fri */}
          <WeekPanel
            events={events}
            anchorIso={weekAnchorISO}
            year={year}
            month={month}
            monthName={MONTH_NAMES[month]}
            todayIso={todayISO}
            selectedIso={selectedDateStr || undefined}
            status={weekStatus}
            onSelectDay={(iso) => setSelectedDay(Number(iso.slice(8, 10)))}
            delay={80}
          />

          {/* Selected day agenda list */}
          <section aria-labelledby="day-list-h" className="basil-rise flex shrink-0 flex-col gap-2" style={{ animationDelay: "160ms" }}>
            {selectedDay ? (
              <>
                <div className="flex items-baseline justify-between gap-2">
                  <h2 id="day-list-h" className="basil-serif text-[22px] leading-tight text-[#10213F]">
                    {selectedDateLabel}
                  </h2>
                  <span className="basil-mono shrink-0 text-[12px] text-[color:var(--w-ink-soft)]">
                    {selectedTimed.length} event{selectedTimed.length === 1 ? "" : "s"}
                  </span>
                </div>
                {selectedTimed.length === 0 ? (
                  <p className="text-[13px] text-[color:var(--w-ink-soft)]">Nothing booked.</p>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {selectedTimed.map((ev, i) => {
                      const t = new Date(ev.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                      const kind = blockKind(ev);
                      return (
                        <li key={i} className="flex items-start gap-2.5 rounded-xl border border-[var(--w-rule)] bg-[var(--w-flimsy)] px-3 py-2">
                          <KindSwatch kind={kind} className="mt-[3px]" />
                          <span className="basil-mono mt-px w-11 shrink-0 text-[12px] text-[color:var(--w-ink-soft)]">{t}</span>
                          <div className="min-w-0 flex-1">
                            <p
                              className="truncate text-[13px] font-medium leading-snug text-[color:var(--w-ink)]"
                              style={{ textDecoration: kind === "declined" ? "line-through" : "none" }}
                            >
                              {ev.summary}
                            </p>
                            {(kind === "invite" || kind === "declined" || ev.hasVideo) && (
                              <p className="text-[12px] leading-snug text-[color:var(--w-ink-soft)]">
                                {kind === "invite" ? "Needs your reply" : kind === "declined" ? "Declined" : null}
                                {(kind === "invite" || kind === "declined") && ev.hasVideo ? " · " : null}
                                {ev.hasVideo && <span className="text-[color:var(--w-carbon)]">Video call</span>}
                              </p>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {/* Proposed for this day */}
                {selectedProposed.length > 0 && (
                  <div className="mt-1 flex flex-col gap-2">
                    <p className="basil-mono text-[11px] uppercase tracking-[0.12em] text-[color:var(--w-manila)]">
                      Proposed ({selectedProposed.length})
                    </p>
                    {selectedProposed.map((p, i) => {
                      const globalIndex = proposed.indexOf(p);
                      return (
                        <div key={i} className="rounded-xl border border-dashed border-[var(--w-rule-strong)] bg-[var(--w-flimsy)] p-3">
                          <p className="truncate text-[14px] font-medium text-[color:var(--w-ink)]">{p.title}</p>
                          <p className="basil-mono text-[12px] text-[color:var(--w-ink-soft)]">{p.startTime} · {p.duration}min</p>
                          <div className="mt-2.5 flex gap-2">
                            <button
                              type="button"
                              disabled={approving === globalIndex}
                              onClick={() => handleApprove(globalIndex)}
                              className={`${BTN_PRIMARY} flex-1`}
                            >
                              {approving === globalIndex ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                              Approve
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDecline(globalIndex)}
                              className={`${BTN_SECONDARY} flex-1 hover:text-[color:var(--w-stamp)]`}
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
              <p id="day-list-h" className="text-[13px] text-[color:var(--w-ink-soft)]">Pick a day on the calendar.</p>
            )}
          </section>

          {/* Pending proposals (global) — if any outside selected day */}
          {otherPending.length > 0 && (
            <section aria-labelledby="other-pending-h" className="flex shrink-0 flex-col gap-1.5">
              <p id="other-pending-h" className="basil-mono text-[11px] uppercase tracking-[0.12em] text-[color:var(--w-manila)]">
                Other pending ({otherPending.length})
              </p>
              <div className="flex max-h-36 flex-col gap-1.5 overflow-y-auto p-0.5">
                {otherPending.map((p) => (
                  <button
                    key={p._index}
                    type="button"
                    className="basil-lift flex min-h-[36px] items-center gap-2 rounded-xl border border-[var(--w-rule)] bg-[var(--w-flimsy)] px-3 text-left text-[13px] text-[color:var(--w-ink)]"
                    onClick={() => {
                      const d = new Date(p.date + "T12:00:00");
                      setYear(d.getFullYear()); setMonth(d.getMonth()); setSelectedDay(d.getDate());
                    }}
                  >
                    <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--w-manila)]" />
                    <span className="basil-mono shrink-0 text-[12px] text-[color:var(--w-ink-soft)]">{p.date}</span>
                    <span className="truncate">{p.title}</span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Ask Basil */}
          <section aria-labelledby="ask-basil-h" className="basil-rise flex shrink-0 flex-col gap-3 rounded-[20px] border border-[var(--w-rule)] bg-[var(--w-flimsy)] p-4" style={{ animationDelay: "240ms" }}>
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center overflow-hidden rounded bg-[#07111F]"><img src="/brand/basil-logo-compass.png" alt="" className="h-8 w-8 max-w-none" /></span>
              <h2 id="ask-basil-h" className="basil-serif text-[22px] leading-none text-[#10213F]">Ask Basil</h2>
            </div>
            {/* Pre-populated scheduling prompts — clicking submits immediately.
                Calendar-flavoured so suggestions are relevant to this surface. */}
            {!basilInput && !basilLoading && (
              <div className="flex flex-wrap gap-1.5">
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
                    className="basil-lift min-h-[36px] rounded-xl border border-[var(--w-rule)] bg-[var(--w-paper)] px-3 py-1.5 text-left text-[13px] leading-snug text-[color:var(--w-ink)]"
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}

            <form id="schedule-basil-form" onSubmit={handleBasilSubmit} className="space-y-2.5">
              <Textarea
                value={basilInput}
                onChange={(e) => setBasilInput(e.target.value)}
                placeholder="Or type your own request…"
                aria-label="Ask Basil to schedule something"
                className="min-h-[64px] resize-none rounded-xl border-[var(--w-rule)] bg-[var(--w-paper)] px-3 py-2.5 text-[13px] leading-relaxed text-[color:var(--w-ink)] placeholder:text-[color:var(--w-ink-soft)] focus-visible:border-[#C8A96B]"
                rows={2}
              />
              <div className="flex items-center justify-between gap-2">
                <p className="text-[12px] leading-snug text-[color:var(--w-ink-soft)]">You approve before any invite sends</p>
                <button
                  type="submit"
                  disabled={basilLoading || !basilInput.trim()}
                  className={`${BTN_PRIMARY} shrink-0`}
                >
                  {basilLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                  Send
                </button>
              </div>
            </form>
            {basilResponse && (
              <p className="basil-serif rounded-xl border border-[var(--w-rule)] bg-[var(--w-paper)] px-3 py-2.5 text-[18px] leading-snug text-[color:var(--w-ink)]">
                {basilResponse}
              </p>
            )}
          </section>
        </aside>

        {/* ── Main: full-width DayView ────────────────────────────────── */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden min-h-[70vh] md:min-h-0 bg-[var(--w-flimsy)]">
          {/* Day header bar */}
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-[var(--w-rule)] px-4 py-3 sm:px-6">
            <div className="flex items-baseline gap-3">
              <h2 className="basil-serif text-[26px] leading-tight text-[#10213F]">
                {selectedDateLabel || "No day selected"}
              </h2>
              {selectedDay && (
                <span className="basil-mono text-[12px] text-[color:var(--w-ink-soft)]">
                  {selectedTimed.length} event{selectedTimed.length !== 1 ? "s" : ""}
                </span>
              )}
            </div>
            {connected ? (
              <KindLegend />
            ) : !loading ? (
              <span className="text-[13px] text-[color:var(--w-ink-soft)]">Connect Google Calendar to see events</span>
            ) : null}
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
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <CalendarPlus className="h-10 w-10 text-[color:var(--w-carbon)]" />
                <p className="text-[15px] text-[color:var(--w-ink-soft)]">Select a day from the mini calendar</p>
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}

