"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Loader2,
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  Check,
  ExternalLink,
  MessageSquare,
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────

interface CalEvent {
  id: string;
  summary?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  isAllDay?: boolean;
}

// ── Time slot grid config ────────────────────────────────────────────────────

/** 30-min slots from 8:00am to 6:30pm (21 slots) */
const TIME_SLOTS: Array<{ hour: number; minute: number; label: string }> = [];
for (let h = 8; h <= 18; h++) {
  for (const m of [0, 30]) {
    if (h === 18 && m === 30) break;
    const h12 = h % 12 === 0 ? 12 : h % 12;
    const suffix = h < 12 ? "am" : "pm";
    TIME_SLOTS.push({ hour: h, minute: m, label: `${h12}:${m === 0 ? "00" : "30"}${suffix}` });
  }
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri"];

// ── Date helpers ─────────────────────────────────────────────────────────────

function getWeekMonday(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function formatDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

function slotOverlaps(
  slotDate: Date,
  hour: number,
  minute: number,
  events: CalEvent[]
): CalEvent | null {
  const slotStart = new Date(slotDate);
  slotStart.setHours(hour, minute, 0, 0);
  const slotEnd = new Date(slotStart.getTime() + 30 * 60 * 1000);

  for (const ev of events) {
    if (ev.isAllDay) continue;
    const evStartStr = ev.start.dateTime;
    const evEndStr = ev.end.dateTime;
    if (!evStartStr || !evEndStr) continue;
    const evStart = new Date(evStartStr);
    const evEnd = new Date(evEndStr);
    if (evStart < slotEnd && evEnd > slotStart) return ev;
  }
  return null;
}

// ── Component ────────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
}

export function ScheduleMeetingModal({ open, onClose }: Props) {
  const router = useRouter();
  const today = formatDate(new Date());
  const [weekStart, setWeekStart] = useState(() => getWeekMonday(new Date()));
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(false);

  // Form state
  const [title, setTitle] = useState("");
  const [selectedDate, setSelectedDate] = useState("");
  const [selectedTime, setSelectedTime] = useState("");
  const [duration, setDuration] = useState("30");
  const [attendees, setAttendees] = useState("");
  const [naturalText, setNaturalText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<{ htmlLink?: string } | null>(null);
  const [submitError, setSubmitError] = useState("");

  // Fetch calendar events when week or open state changes
  useEffect(() => {
    if (!open) return;
    setLoading(true);

    const fetchMonth = (y: number, m: number) =>
      fetch(`/api/calendar/month?year=${y}&month=${m}`)
        .then((r) => (r.ok ? r.json() : { events: [] }))
        .then((d: { events?: CalEvent[] }) => d.events ?? []);

    const year = weekStart.getFullYear();
    const month = weekStart.getMonth();
    const weekEnd = addDays(weekStart, 4);
    const promises: Promise<CalEvent[]>[] = [fetchMonth(year, month)];
    if (weekEnd.getMonth() !== month) {
      promises.push(fetchMonth(weekEnd.getFullYear(), weekEnd.getMonth()));
    }

    Promise.all(promises)
      .then((results) => setEvents(results.flat()))
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));
  }, [open, weekStart]);

  const weekDays = Array.from({ length: 5 }, (_, i) => addDays(weekStart, i));
  const weekLabel = `${weekStart.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  })} – ${addDays(weekStart, 4).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })}`;

  function handleSlotClick(dayDate: Date, hour: number, minute: number) {
    setSelectedDate(formatDate(dayDate));
    setSelectedTime(`${String(hour).padStart(2, "0")}:${minute === 0 ? "00" : "30"}`);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !selectedDate || !selectedTime) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      const res = await fetch("/api/calendar/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          date: selectedDate,
          startTime: selectedTime,
          duration: parseInt(duration),
          attendees: attendees
            .split(",")
            .map((a) => a.trim())
            .filter(Boolean),
        }),
      });
      const data = (await res.json()) as { error?: string; htmlLink?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to create event");
      setSuccess({ htmlLink: data.htmlLink });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  function handleNaturalSubmit() {
    if (!naturalText.trim()) return;
    resetAndClose();
    router.push(`/dashboard/chat?q=${encodeURIComponent(naturalText.trim())}`);
  }

  function resetAndClose() {
    setTitle("");
    setSelectedDate("");
    setSelectedTime("");
    setDuration("30");
    setAttendees("");
    setNaturalText("");
    setSuccess(null);
    setSubmitError("");
    onClose();
  }

  const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) resetAndClose(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden flex flex-col p-0 gap-0">
        <DialogHeader className="px-5 pt-5 pb-3 border-b border-border shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base">
            <CalendarPlus className="h-4 w-4 text-[oklch(0.72_0.15_85)]" />
            Schedule a meeting
          </DialogTitle>
        </DialogHeader>

        {/* ── Success state ──────────────────────────────────────────────── */}
        {success ? (
          <div className="flex flex-col items-center justify-center flex-1 p-10 text-center gap-4">
            <div className="h-12 w-12 rounded-full bg-emerald-100 flex items-center justify-center">
              <Check className="h-6 w-6 text-emerald-600" />
            </div>
            <div>
              <p className="font-medium">Meeting scheduled!</p>
              <p className="text-sm text-muted-foreground mt-1">
                {title} · {selectedDate} at {selectedTime}
              </p>
            </div>
            <div className="flex gap-3">
              {success.htmlLink && (
                <a href={success.htmlLink} target="_blank" rel="noopener noreferrer">
                  <Button variant="outline" size="sm" className="gap-1.5">
                    <ExternalLink className="h-3.5 w-3.5" />
                    View in Google Calendar
                  </Button>
                </a>
              )}
              <Button size="sm" onClick={resetAndClose}>Done</Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 min-h-0">
            {/* ── Left: availability grid ────────────────────────────────── */}
            <div className="flex flex-col flex-1 min-w-0 border-r border-border overflow-hidden">
              {/* Week nav */}
              <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
                <button
                  type="button"
                  onClick={() => setWeekStart((d) => addDays(d, -7))}
                  className="p-1 rounded hover:bg-muted transition-colors"
                  aria-label="Previous week"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="text-xs font-medium text-muted-foreground">{weekLabel}</span>
                <button
                  type="button"
                  onClick={() => setWeekStart((d) => addDays(d, 7))}
                  className="p-1 rounded hover:bg-muted transition-colors"
                  aria-label="Next week"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>

              {/* Day headers */}
              <div className="grid grid-cols-[36px_repeat(5,1fr)] border-b border-border shrink-0">
                <div />
                {weekDays.map((d, i) => {
                  const isToday = formatDate(d) === today;
                  return (
                    <div
                      key={i}
                      className={`px-1 py-1.5 text-center border-l border-border/40 ${
                        isToday ? "bg-[oklch(0.72_0.15_85)]/10" : ""
                      }`}
                    >
                      <p className="text-[10px] text-muted-foreground font-medium">{DAY_NAMES[i]}</p>
                      <p
                        className={`text-xs font-semibold leading-tight ${
                          isToday ? "text-[oklch(0.55_0.15_85)]" : ""
                        }`}
                      >
                        {d.getDate()}
                      </p>
                    </div>
                  );
                })}
              </div>

              {/* Scrollable time grid */}
              <div className="overflow-y-auto flex-1">
                {loading ? (
                  <div className="flex items-center justify-center h-32">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <div>
                    {TIME_SLOTS.map(({ hour, minute, label }, si) => (
                      <div
                        key={si}
                        className={`grid grid-cols-[36px_repeat(5,1fr)] ${
                          minute === 0 ? "border-t border-border/20" : ""
                        }`}
                      >
                        {/* Time gutter */}
                        <div className="flex items-start justify-end pr-1.5 pt-0.5">
                          {minute === 0 && (
                            <span className="text-[9px] text-muted-foreground/60 leading-none whitespace-nowrap">
                              {label}
                            </span>
                          )}
                        </div>

                        {weekDays.map((dayDate, di) => {
                          const busyEv = slotOverlaps(dayDate, hour, minute, events);
                          const dateStr = formatDate(dayDate);
                          const timeStr = `${String(hour).padStart(2, "0")}:${minute === 0 ? "00" : "30"}`;
                          const isSelected = selectedDate === dateStr && selectedTime === timeStr;
                          const isPastDay = dayDate < new Date(today);
                          const isPastSlot =
                            dateStr === today &&
                            hour * 60 + minute < nowMinutes;
                          const isPast = isPastDay || isPastSlot;

                          return (
                            <button
                              key={di}
                              type="button"
                              disabled={!!busyEv || isPast}
                              onClick={() => !busyEv && !isPast && handleSlotClick(dayDate, hour, minute)}
                              title={busyEv?.summary ?? undefined}
                              className={[
                                "h-5 border-l border-border/30 transition-colors overflow-hidden px-0.5",
                                busyEv
                                  ? "bg-[oklch(0.72_0.15_85)]/25 cursor-default"
                                  : isPast
                                    ? "bg-muted/25 cursor-default"
                                    : isSelected
                                      ? "bg-emerald-400/30 ring-1 ring-inset ring-emerald-500/40"
                                      : "hover:bg-[oklch(0.72_0.15_85)]/15 cursor-pointer",
                              ]
                                .filter(Boolean)
                                .join(" ")}
                            >
                              {busyEv && minute === 0 && (
                                <span className="text-[8px] text-[oklch(0.45_0.12_85)] leading-tight truncate block">
                                  {busyEv.summary}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Grid legend */}
              <div className="px-3 py-1.5 border-t border-border/50 flex items-center gap-4 shrink-0">
                <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <span className="h-2.5 w-3 rounded-sm bg-[oklch(0.72_0.15_85)]/25 inline-block" />
                  Busy
                </span>
                <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <span className="h-2.5 w-3 rounded-sm bg-emerald-400/30 inline-block" />
                  Selected
                </span>
                <span className="text-[10px] text-muted-foreground">
                  Click a free slot to pre-fill time
                </span>
              </div>
            </div>

            {/* ── Right: form ────────────────────────────────────────────── */}
            <div className="w-60 flex flex-col shrink-0 overflow-y-auto">
              <form onSubmit={handleSubmit} className="flex flex-col gap-3.5 p-4 flex-1">
                <div className="space-y-1">
                  <Label htmlFor="sched-title" className="text-xs">
                    Title <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="sched-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Meeting title"
                    className="h-8 text-sm"
                    required
                  />
                </div>

                <div className="space-y-1">
                  <Label htmlFor="sched-date" className="text-xs">
                    Date <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="sched-date"
                    type="date"
                    value={selectedDate}
                    onChange={(e) => setSelectedDate(e.target.value)}
                    className="h-8 text-sm"
                    required
                  />
                </div>

                <div className="space-y-1">
                  <Label htmlFor="sched-time" className="text-xs">
                    Start time <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="sched-time"
                    type="time"
                    value={selectedTime}
                    onChange={(e) => setSelectedTime(e.target.value)}
                    className="h-8 text-sm"
                    required
                  />
                  {!selectedDate && !selectedTime && (
                    <p className="text-[10px] text-muted-foreground">
                      Or click a slot in the grid
                    </p>
                  )}
                </div>

                <div className="space-y-1">
                  <Label htmlFor="sched-duration" className="text-xs">
                    Duration
                  </Label>
                  <select
                    id="sched-duration"
                    value={duration}
                    onChange={(e) => setDuration(e.target.value)}
                    className="flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="15">15 min</option>
                    <option value="30">30 min</option>
                    <option value="45">45 min</option>
                    <option value="60">1 hour</option>
                    <option value="90">1.5 hours</option>
                    <option value="120">2 hours</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="sched-attendees" className="text-xs">
                    Attendees
                  </Label>
                  <Input
                    id="sched-attendees"
                    value={attendees}
                    onChange={(e) => setAttendees(e.target.value)}
                    placeholder="email1, email2..."
                    className="h-8 text-sm"
                  />
                </div>

                {submitError && (
                  <p className="text-xs text-destructive">{submitError}</p>
                )}

                <Button
                  type="submit"
                  size="sm"
                  disabled={submitting || !title.trim() || !selectedDate || !selectedTime}
                  className="bg-gradient-to-r from-[oklch(0.72_0.15_85)] to-[oklch(0.78_0.12_85)] hover:from-[oklch(0.78_0.12_85)] hover:to-[oklch(0.82_0.10_85)] text-white gap-1.5 mt-auto"
                >
                  {submitting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <CalendarPlus className="h-3.5 w-3.5" />
                  )}
                  Schedule
                </Button>
              </form>

              {/* Natural language fallback */}
              <div className="px-4 pb-4 border-t border-border pt-3 space-y-1.5 shrink-0">
                <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
                  Or let Basil do it
                </p>
                <div className="flex gap-1">
                  <Input
                    value={naturalText}
                    onChange={(e) => setNaturalText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleNaturalSubmit();
                      }
                    }}
                    placeholder="30-min call with..."
                    className="h-7 text-xs"
                  />
                  <button
                    type="button"
                    onClick={handleNaturalSubmit}
                    disabled={!naturalText.trim()}
                    title="Ask Basil to schedule this"
                    className="flex items-center justify-center h-7 w-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40"
                  >
                    <MessageSquare className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
