"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  Send,
  Loader2,
  Clock,
  Users,
  Video,
  Unplug,
  Check,
  X,
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
  attendees?: string[];
  dateLabel?: string;
}

interface ProposedMeeting {
  title: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:MM
  duration: number;
  attendees: string[];
  status: "proposed" | "approved" | "declined";
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
  const [selectedDay, setSelectedDay] = useState<number | null>(now.getDate());
  const [basilInput, setBasilInput] = useState("");
  const [basilLoading, setBasilLoading] = useState(false);
  const [basilResponse, setBasilResponse] = useState("");
  const [proposed, setProposed] = useState<ProposedMeeting[]>([]);
  const [approving, setApproving] = useState<number | null>(null);
  const hydrated = useRef(false);

  // Hydrate proposed meetings + last Basil response from localStorage on mount.
  // Drop proposals whose date has already passed — stale "proposed" entries
  // from days ago would clutter the diary view.
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    try {
      const cached = localStorage.getItem("sage-schedule-v1");
      if (!cached) return;
      const parsed = JSON.parse(cached) as {
        proposed?: ProposedMeeting[];
        basilResponse?: string;
      };
      const today = new Date().toISOString().slice(0, 10);
      const fresh = (parsed.proposed || []).filter((p) => p.date >= today);
      if (fresh.length > 0) setProposed(fresh);
      if (parsed.basilResponse) setBasilResponse(parsed.basilResponse);
    } catch {
      /* ignore bad cache */
    }
  }, []);

  // Persist proposed + basilResponse on change (skip during pre-hydration render).
  useEffect(() => {
    if (!hydrated.current) return;
    try {
      localStorage.setItem(
        "sage-schedule-v1",
        JSON.stringify({ proposed, basilResponse })
      );
    } catch {
      /* localStorage full or unavailable */
    }
  }, [proposed, basilResponse]);

  // Fetch events for the visible month
  const fetchEvents = useCallback(() => {
    setLoading(true);
    fetch(`/api/calendar/month?year=${year}&month=${month}`)
      .then((r) => r.json())
      .then((d) => {
        setConnected(d.connected);
        setEvents(d.events || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
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
  const todayDay =
    now.getFullYear() === year && now.getMonth() === month ? now.getDate() : -1;

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

  return (
    <div className="p-4 sm:p-6 lg:p-8 pb-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <CalendarPlus className="h-6 w-6 text-[oklch(0.72_0.15_85)]" />
          Schedule
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Monthly diary. Ask Basil to schedule meetings — you approve before any
          invite sends.
        </p>
      </header>

      {!connected && !loading && (
        <Card className="border-[oklch(0.72_0.15_85)]/30 mb-6">
          <CardContent className="py-6 text-center">
            <Unplug className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">
              Google Calendar not connected.
            </p>
            <Link
              href="/dashboard/settings"
              className="text-xs text-[oklch(0.72_0.15_85)] hover:underline mt-2 inline-block"
            >
              Connect in Settings
            </Link>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        {/* Calendar grid */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <Button variant="ghost" size="icon" onClick={prevMonth}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <CardTitle className="text-sm font-semibold">
              {MONTH_NAMES[month]} {year}
            </CardTitle>
            <Button variant="ghost" size="icon" onClick={nextMonth}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-2">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-48 w-full" />
              </div>
            ) : (
              <>
                {/* Day headers */}
                <div className="grid grid-cols-7 gap-1 mb-1">
                  {DAY_NAMES.map((d) => (
                    <div
                      key={d}
                      className="text-center text-[12px] font-semibold text-muted-foreground uppercase py-1"
                    >
                      {d}
                    </div>
                  ))}
                </div>
                {/* Days grid */}
                <div className="grid grid-cols-7 gap-1">
                  {/* Empty cells for days before the 1st */}
                  {Array.from({ length: firstDay }).map((_, i) => (
                    <div key={`empty-${i}`} className="h-20" />
                  ))}
                  {/* Actual days */}
                  {Array.from({ length: daysInMonth }).map((_, i) => {
                    const day = i + 1;
                    const isToday = day === todayDay;
                    const isSelected = day === selectedDay;
                    const dayEvents = eventsByDay[day] || [];
                    const dayProposed = proposedByDay[day] || [];
                    const timedEvents = dayEvents.filter((ev) => !ev.isAllDay);
                    const hasProposed = dayProposed.some(
                      (p) => p.status === "proposed"
                    );

                    return (
                      <button
                        key={day}
                        onClick={() => setSelectedDay(day)}
                        className={`h-20 rounded-md text-left p-1 transition-colors relative ${
                          isSelected
                            ? "bg-[oklch(0.72_0.15_85)]/15 ring-1 ring-[oklch(0.72_0.15_85)]"
                            : hasProposed
                              ? "bg-amber-500/5 border border-dashed border-amber-400/50 hover:bg-amber-500/10"
                              : "hover:bg-accent/50"
                        }`}
                      >
                        <span
                          className={`text-xs font-medium ${
                            isToday
                              ? "bg-[oklch(0.72_0.15_85)] text-white rounded-full w-5 h-5 flex items-center justify-center"
                              : ""
                          }`}
                        >
                          {day}
                        </span>
                        {/* Confirmed events */}
                        {timedEvents.length > 0 && (
                          <div className="mt-0.5">
                            {timedEvents.slice(0, 2).map((ev, j) => (
                              <div
                                key={j}
                                className="text-[12px] truncate text-muted-foreground leading-tight"
                              >
                                {ev.summary}
                              </div>
                            ))}
                            {timedEvents.length > 2 && (
                              <div className="text-[12px] text-[oklch(0.72_0.15_85)]">
                                +{timedEvents.length - 2} more
                              </div>
                            )}
                          </div>
                        )}
                        {/* Proposed meetings overlay */}
                        {dayProposed
                          .filter((p) => p.status === "proposed")
                          .slice(0, 1)
                          .map((p, j) => (
                            <div
                              key={`prop-${j}`}
                              className="text-[12px] truncate text-amber-600 font-medium leading-tight mt-0.5"
                            >
                              {p.title}
                            </div>
                          ))}
                        {dayProposed.filter((p) => p.status === "proposed")
                          .length > 1 && (
                          <div className="text-[12px] text-amber-500">
                            +
                            {dayProposed.filter((p) => p.status === "proposed")
                              .length - 1}{" "}
                            proposed
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Right panel: day detail + Basil input */}
        <div className="space-y-4">
          {/* Selected day events */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">
                {selectedDay
                  ? `${MONTH_NAMES[month]} ${selectedDay}`
                  : "Select a day"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {!selectedDay ? (
                <p className="text-sm text-muted-foreground">
                  Click a day to see meetings.
                </p>
              ) : (
                <div className="space-y-2">
                  {/* Confirmed events */}
                  {selectedEvents.filter((ev) => !ev.isAllDay).length === 0 &&
                    selectedProposed.length === 0 && (
                      <p className="text-sm text-muted-foreground">
                        No meetings this day.
                      </p>
                    )}
                  {selectedEvents
                    .filter((ev) => !ev.isAllDay)
                    .map((ev) => (
                      <div
                        key={ev.id}
                        className="rounded-md p-2 bg-accent/30 text-sm"
                      >
                        <div className="flex items-center gap-2">
                          <Clock className="h-3 w-3 text-muted-foreground shrink-0" />
                          <span className="font-mono text-xs">
                            {formatTime(ev.start)} – {formatTime(ev.end)}
                          </span>
                          {ev.hasVideo && (
                            <Video className="h-3 w-3 text-blue-400" />
                          )}
                        </div>
                        <p className="font-medium mt-0.5">{ev.summary}</p>
                        {ev.attendees && ev.attendees.length > 0 && (
                          <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                            <Users className="h-3 w-3" />{" "}
                            {ev.attendees.slice(0, 3).join(", ")}
                            {ev.attendees.length > 3 &&
                              ` +${ev.attendees.length - 3}`}
                          </p>
                        )}
                      </div>
                    ))}

                  {/* Proposed meetings for this day */}
                  {selectedProposed.length > 0 && (
                    <>
                      {selectedEvents.filter((ev) => !ev.isAllDay).length >
                        0 && <Separator className="my-2" />}
                      {selectedProposed.map((p, i) => {
                        const globalIndex = proposed.indexOf(p);
                        return (
                          <div
                            key={`proposed-${i}`}
                            className={`rounded-md p-2 text-sm border ${
                              p.status === "approved"
                                ? "bg-emerald-500/5 border-emerald-400/30"
                                : "bg-amber-500/5 border-dashed border-amber-400/30"
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <Clock className="h-3 w-3 text-muted-foreground shrink-0" />
                              <span className="font-mono text-xs">
                                {p.startTime} · {p.duration}min
                              </span>
                              <Badge
                                variant="outline"
                                className={`text-[12px] h-4 ml-auto ${
                                  p.status === "approved"
                                    ? "border-emerald-400/50 text-emerald-600"
                                    : "border-amber-400/50 text-amber-600"
                                }`}
                              >
                                {p.status === "approved"
                                  ? "Approved"
                                  : "Proposed"}
                              </Badge>
                            </div>
                            <p className="font-medium mt-0.5">{p.title}</p>
                            {p.attendees.length > 0 && (
                              <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                                <Users className="h-3 w-3" />{" "}
                                {p.attendees.slice(0, 3).join(", ")}
                                {p.attendees.length > 3 &&
                                  ` +${p.attendees.length - 3}`}
                              </p>
                            )}
                            {p.status === "proposed" && (
                              <div className="flex gap-2 mt-2">
                                <Button
                                  size="sm"
                                  className="bg-emerald-500 hover:bg-emerald-600 text-white text-xs h-7 gap-1"
                                  disabled={approving === globalIndex}
                                  onClick={() => handleApprove(globalIndex)}
                                >
                                  {approving === globalIndex ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    <Check className="h-3 w-3" />
                                  )}
                                  Approve & Send
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="text-xs h-7 border-destructive/30 text-destructive gap-1"
                                  onClick={() => handleDecline(globalIndex)}
                                >
                                  <X className="h-3 w-3" />
                                  Decline
                                </Button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Basil scheduling input */}
          <Card className="border-[oklch(0.72_0.15_85)]/30">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-1.5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/basil-logo.svg"
                  alt=""
                  className="h-4 w-4 rounded"
                />
                Ask Basil to schedule
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleBasilSubmit} className="space-y-3">
                <Textarea
                  value={basilInput}
                  onChange={(e) => setBasilInput(e.target.value)}
                  placeholder="e.g. Schedule a 30 min call with Ed tomorrow at 2pm..."
                  className="min-h-20 resize-none text-sm leading-relaxed"
                  rows={3}
                />
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-muted-foreground leading-snug">
                    Basil will propose — you approve before any invite sends
                  </p>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={basilLoading || !basilInput.trim()}
                    className="shrink-0 bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)] hover:bg-[oklch(0.78_0.12_85)] gap-1.5"
                  >
                    {basilLoading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Send className="h-3.5 w-3.5" />
                    )}
                    Send
                  </Button>
                </div>
              </form>
              {basilResponse && (
                <div className="mt-3 p-2 rounded bg-accent/30 text-xs text-muted-foreground">
                  {basilResponse}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Pending proposals summary */}
          {proposed.filter((p) => p.status === "proposed").length > 0 && (
            <Card className="border-amber-400/30">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-amber-600">
                  Pending Approval ({proposed.filter((p) => p.status === "proposed").length})
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {proposed
                  .map((p, i) => ({ ...p, _index: i }))
                  .filter((p) => p.status === "proposed")
                  .map((p) => (
                    <div
                      key={p._index}
                      className="rounded-md p-3 bg-amber-500/5 border border-dashed border-amber-400/20"
                    >
                      <p className="text-sm font-medium">{p.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {p.date} at {p.startTime} · {p.duration}min
                      </p>
                      {p.attendees.length > 0 && (
                        <p className="text-xs text-muted-foreground">
                          {p.attendees.join(", ")}
                        </p>
                      )}
                      <div className="flex gap-2 mt-2">
                        <Button
                          size="sm"
                          className="bg-emerald-500 hover:bg-emerald-600 text-white text-xs h-7 gap-1"
                          disabled={approving === p._index}
                          onClick={() => handleApprove(p._index)}
                        >
                          {approving === p._index ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Check className="h-3 w-3" />
                          )}
                          Approve & Send
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-xs h-7 border-destructive/30 text-destructive gap-1"
                          onClick={() => handleDecline(p._index)}
                        >
                          <X className="h-3 w-3" />
                          Decline
                        </Button>
                      </div>
                    </div>
                  ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
