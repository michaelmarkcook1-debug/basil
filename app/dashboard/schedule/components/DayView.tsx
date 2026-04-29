"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { X, Trash2, Video, Users, Save, Loader2, Plus } from "lucide-react";

// ─── Constants ────────────────────────────────────────────────────────────────
const HOUR_HEIGHT   = 80;          // px per hour
const PX_PER_MIN    = HOUR_HEIGHT / 60;
const GRID_START_H  = 7;           // 07:00
const GRID_END_H    = 21;          // 21:00
const SNAP_MINUTES  = 15;
const MIN_DURATION  = 15;          // minimum event duration in minutes

function snapMin(m: number) {
  return Math.round(m / SNAP_MINUTES) * SNAP_MINUTES;
}
function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
function minToTime(totalMin: number): string {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function timeToMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// ─── Types ────────────────────────────────────────────────────────────────────
export interface DayEvent {
  id: string;
  summary: string;
  start: string;   // ISO dateTime or date
  end: string;
  isAllDay: boolean;
  hasVideo: boolean;
  attendees: string[];
}

interface EditState {
  eventId: string | null; // null = new event
  title: string;
  date: string;           // YYYY-MM-DD
  startTime: string;      // HH:MM
  durationMin: number;
  attendees: string;      // comma-separated
}

interface DragState {
  eventId: string;
  type: "move" | "resize";
  startY: number;
  origStartMin: number;
  origEndMin: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function parseEventTimes(e: DayEvent): { startMin: number; endMin: number } {
  // start/end are ISO dateTime strings like "2026-04-30T09:00:00+01:00"
  // or date-only "2026-04-30" for all-day
  const startDate = new Date(e.start);
  const endDate   = new Date(e.end);
  const startMin  = startDate.getHours() * 60 + startDate.getMinutes();
  const endMin    = endDate.getHours() * 60 + endDate.getMinutes() || startMin + 60;
  return { startMin, endMin };
}

function eventTop(startMin: number): number {
  return (startMin - GRID_START_H * 60) * PX_PER_MIN;
}
function eventHeight(startMin: number, endMin: number): number {
  return Math.max(MIN_DURATION * PX_PER_MIN, (endMin - startMin) * PX_PER_MIN);
}

const HOURS = Array.from({ length: GRID_END_H - GRID_START_H }, (_, i) => GRID_START_H + i);

// ─── EventBlock ───────────────────────────────────────────────────────────────
function EventBlock({
  event,
  dragging,
  dragStartMin,
  dragEndMin,
  onDragStart,
  onResizeStart,
  onDoubleClick,
}: {
  event: DayEvent;
  dragging: boolean;
  dragStartMin: number;
  dragEndMin: number;
  onDragStart: (e: React.MouseEvent, id: string) => void;
  onResizeStart: (e: React.MouseEvent, id: string) => void;
  onDoubleClick: (event: DayEvent) => void;
}) {
  const { startMin, endMin } = parseEventTimes(event);
  const displayStart = dragging ? dragStartMin : startMin;
  const displayEnd   = dragging ? dragEndMin   : endMin;
  const top    = eventTop(displayStart);
  const height = eventHeight(displayStart, displayEnd);

  // Color by event type
  let bg = "bg-[oklch(0.72_0.15_85)]/20 border-[oklch(0.72_0.15_85)]/50";
  let text = "text-[oklch(0.4_0.1_85)]";
  const lower = event.summary.toLowerCase();
  if (lower.includes("focus") || lower.includes("deep work")) {
    bg = "bg-blue-500/10 border-blue-400/40";
    text = "text-blue-700 dark:text-blue-300";
  } else if (lower.includes("lunch") || lower.includes("break")) {
    bg = "bg-emerald-500/10 border-emerald-400/40";
    text = "text-emerald-700 dark:text-emerald-300";
  }

  return (
    <div
      className={`absolute left-0 right-2 rounded-md border px-2 py-1 select-none
        ${bg} ${dragging ? "opacity-70 shadow-lg ring-2 ring-[oklch(0.72_0.15_85)] z-20" : "hover:shadow-md z-10"}
        transition-shadow cursor-grab active:cursor-grabbing`}
      style={{ top: `${top}px`, height: `${height}px`, minHeight: `${MIN_DURATION * PX_PER_MIN}px` }}
      onMouseDown={(e) => { e.stopPropagation(); onDragStart(e, event.id); }}
      onDoubleClick={(e) => { e.stopPropagation(); onDoubleClick(event); }}
    >
      <div className="flex items-start gap-1 overflow-hidden h-full">
        <div className="flex-1 min-w-0">
          <p className={`text-xs font-semibold leading-tight truncate ${text}`}>
            {event.summary}
          </p>
          {height >= 36 && (
            <p className="text-[11px] text-muted-foreground leading-tight">
              {minToTime(displayStart)} – {minToTime(displayEnd)}
            </p>
          )}
          {height >= 52 && event.attendees.length > 0 && (
            <p className="text-[10px] text-muted-foreground truncate flex items-center gap-0.5 mt-0.5">
              <Users className="h-2.5 w-2.5 inline shrink-0" />
              {event.attendees.slice(0, 2).join(", ")}
              {event.attendees.length > 2 && ` +${event.attendees.length - 2}`}
            </p>
          )}
        </div>
        {event.hasVideo && height >= 36 && (
          <Video className="h-3 w-3 text-blue-400 shrink-0 mt-0.5" />
        )}
      </div>
      {/* Resize handle */}
      <div
        className="absolute bottom-0 left-0 right-0 h-3 cursor-ns-resize flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity"
        onMouseDown={(e) => { e.stopPropagation(); onResizeStart(e, event.id); }}
      >
        <div className="w-8 h-1 rounded-full bg-current opacity-40" />
      </div>
    </div>
  );
}

// ─── EditModal ────────────────────────────────────────────────────────────────
function EditModal({
  state,
  onClose,
  onSave,
  onDelete,
  saving,
  deleting,
  onChange,
}: {
  state: EditState;
  onClose: () => void;
  onSave: () => void;
  onDelete: () => void;
  saving: boolean;
  deleting: boolean;
  onChange: (patch: Partial<EditState>) => void;
}) {
  const isNew = state.eventId === null;
  const endMin = timeToMin(state.startTime) + state.durationMin;
  const endTime = minToTime(clamp(endMin, 0, 23 * 60 + 59));

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md bg-card border border-border rounded-xl shadow-2xl p-6 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-base">
            {isNew ? "New Event" : "Edit Event"}
          </h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Title */}
        <div className="space-y-1.5">
          <Label htmlFor="ev-title" className="text-xs font-medium">Title</Label>
          <Input
            id="ev-title"
            value={state.title}
            onChange={(e) => onChange({ title: e.target.value })}
            placeholder="Meeting title"
            className="h-9 text-sm"
            autoFocus
          />
        </div>

        {/* Date + Time row */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="ev-date" className="text-xs font-medium">Date</Label>
            <Input
              id="ev-date"
              type="date"
              value={state.date}
              onChange={(e) => onChange({ date: e.target.value })}
              className="h-9 text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ev-start" className="text-xs font-medium">Start time</Label>
            <Input
              id="ev-start"
              type="time"
              step={900}
              value={state.startTime}
              onChange={(e) => onChange({ startTime: e.target.value })}
              className="h-9 text-sm"
            />
          </div>
        </div>

        {/* Duration + End time row */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="ev-duration" className="text-xs font-medium">Duration</Label>
            <select
              id="ev-duration"
              value={state.durationMin}
              onChange={(e) => onChange({ durationMin: Number(e.target.value) })}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              {[15, 30, 45, 60, 90, 120, 180, 240].map((d) => (
                <option key={d} value={d}>
                  {d < 60 ? `${d} min` : `${d / 60}h${d % 60 ? ` ${d % 60}m` : ""}`}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">Ends at</Label>
            <div className="h-9 flex items-center px-3 rounded-md border border-input bg-muted/30 text-sm text-muted-foreground">
              {endTime}
            </div>
          </div>
        </div>

        {/* Attendees */}
        <div className="space-y-1.5">
          <Label htmlFor="ev-attendees" className="text-xs font-medium">Attendees <span className="text-muted-foreground font-normal">(emails, comma-separated)</span></Label>
          <Input
            id="ev-attendees"
            value={state.attendees}
            onChange={(e) => onChange({ attendees: e.target.value })}
            placeholder="alice@co.com, bob@co.com"
            className="h-9 text-sm"
          />
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 pt-1">
          <Button
            onClick={onSave}
            disabled={saving || !state.title.trim()}
            className="flex-1 h-9 bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)] hover:bg-[oklch(0.78_0.12_85)] gap-1.5"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {isNew ? "Create" : "Save changes"}
          </Button>
          {!isNew && (
            <Button
              variant="outline"
              onClick={onDelete}
              disabled={deleting}
              className="h-9 border-destructive/40 text-destructive hover:bg-destructive/10 gap-1.5"
            >
              {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              Delete
            </Button>
          )}
          <Button variant="ghost" onClick={onClose} className="h-9 px-3">Cancel</Button>
        </div>
      </div>
    </div>
  );
}

// ─── DayView (main export) ────────────────────────────────────────────────────
export function DayView({
  date,
  events,
  onRefresh,
}: {
  date: string;          // YYYY-MM-DD
  events: DayEvent[];
  onRefresh: () => void;
}) {
  const gridRef      = useRef<HTMLDivElement>(null);
  const [drag, setDrag]       = useState<DragState | null>(null);
  const [dragPos, setDragPos] = useState<{ startMin: number; endMin: number } | null>(null);
  const [editState, setEditState] = useState<EditState | null>(null);
  const [saving, setSaving]   = useState(false);
  const [deleting, setDeleting] = useState(false);

  // ── Drag helpers ───────────────────────────────────────────────────────────
  const yToMin = useCallback((clientY: number): number => {
    const rect = gridRef.current?.getBoundingClientRect();
    if (!rect) return GRID_START_H * 60;
    const pxFromTop = clientY - rect.top;
    const raw = GRID_START_H * 60 + pxFromTop / PX_PER_MIN;
    return clamp(snapMin(raw), GRID_START_H * 60, GRID_END_H * 60 - MIN_DURATION);
  }, []);

  const startDrag = useCallback((e: React.MouseEvent, eventId: string, type: "move" | "resize") => {
    if (e.button !== 0) return;
    const ev = events.find((x) => x.id === eventId);
    if (!ev) return;
    const { startMin, endMin } = parseEventTimes(ev);
    setDrag({ eventId, type, startY: e.clientY, origStartMin: startMin, origEndMin: endMin });
    setDragPos({ startMin, endMin });
    e.preventDefault();
  }, [events]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!drag) return;
    const deltaY = e.clientY - drag.startY;
    const deltaMin = snapMin(deltaY / PX_PER_MIN);

    if (drag.type === "move") {
      const dur = drag.origEndMin - drag.origStartMin;
      const newStart = clamp(drag.origStartMin + deltaMin, GRID_START_H * 60, GRID_END_H * 60 - dur);
      setDragPos({ startMin: newStart, endMin: newStart + dur });
    } else {
      const newEnd = clamp(drag.origEndMin + deltaMin, drag.origStartMin + MIN_DURATION, GRID_END_H * 60);
      setDragPos({ startMin: drag.origStartMin, endMin: snapMin(newEnd) });
    }
  }, [drag]);

  const onMouseUp = useCallback(async () => {
    if (!drag || !dragPos) { setDrag(null); setDragPos(null); return; }
    const ev = events.find((x) => x.id === drag.eventId);
    if (!ev) { setDrag(null); setDragPos(null); return; }

    const { startMin: origStart, endMin: origEnd } = parseEventTimes(ev);
    const noChange = dragPos.startMin === origStart && dragPos.endMin === origEnd;
    setDrag(null);
    setDragPos(null);

    if (noChange) return;

    const newStartTime = minToTime(dragPos.startMin);
    const newDuration  = dragPos.endMin - dragPos.startMin;

    try {
      await fetch(`/api/calendar/${drag.eventId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startTime: newStartTime, duration: newDuration }),
      });
      onRefresh();
    } catch {
      // silent — event snaps back on refresh
    }
  }, [drag, dragPos, events, onRefresh]);

  // ── Edit modal ─────────────────────────────────────────────────────────────
  const openEdit = useCallback((event: DayEvent) => {
    const { startMin, endMin } = parseEventTimes(event);
    setEditState({
      eventId: event.id,
      title: event.summary,
      date,
      startTime: minToTime(startMin),
      durationMin: endMin - startMin,
      attendees: event.attendees.join(", "),
    });
  }, [date]);

  const openNew = useCallback((clickMin?: number) => {
    const startMin = clickMin ?? 9 * 60;
    setEditState({
      eventId: null,
      title: "",
      date,
      startTime: minToTime(startMin),
      durationMin: 30,
      attendees: "",
    });
  }, [date]);

  const handleSave = async () => {
    if (!editState) return;
    setSaving(true);
    try {
      const attendeeList = editState.attendees
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      if (editState.eventId) {
        await fetch(`/api/calendar/${editState.eventId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: editState.title,
            date: editState.date,
            startTime: editState.startTime,
            duration: editState.durationMin,
            attendees: attendeeList,
          }),
        });
      } else {
        await fetch("/api/calendar/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: editState.title,
            date: editState.date,
            startTime: editState.startTime,
            duration: editState.durationMin,
            attendees: attendeeList,
          }),
        });
      }
      setEditState(null);
      onRefresh();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!editState?.eventId) return;
    setDeleting(true);
    try {
      await fetch(`/api/calendar/${editState.eventId}`, { method: "DELETE" });
      setEditState(null);
      onRefresh();
    } finally {
      setDeleting(false);
    }
  };

  // Grid click → open new event
  const handleGridClick = (e: React.MouseEvent) => {
    if (drag) return; // ignore click at drag end
    const rect = gridRef.current?.getBoundingClientRect();
    if (!rect) return;
    const clickMin = snapMin(GRID_START_H * 60 + (e.clientY - rect.top) / PX_PER_MIN);
    openNew(clickMin);
  };

  // Stop listening if mouse leaves window
  useEffect(() => {
    if (!drag) return;
    const up = () => onMouseUp();
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, [drag, onMouseUp]);

  // ── Timed events only (all-day events shown above the grid) ───────────────
  const allDayEvents = events.filter((e) => e.isAllDay);
  const timedEvents  = events.filter((e) => !e.isAllDay);

  const totalGridHeight = (GRID_END_H - GRID_START_H) * HOUR_HEIGHT;

  return (
    <div className="flex flex-col h-full">
      {/* All-day events strip */}
      {allDayEvents.length > 0 && (
        <div className="px-2 py-1.5 border-b border-border bg-muted/20 flex flex-wrap gap-1.5">
          {allDayEvents.map((e) => (
            <span
              key={e.id}
              className="text-xs px-2 py-0.5 rounded-full bg-[oklch(0.72_0.15_85)]/15 text-[oklch(0.5_0.1_85)] border border-[oklch(0.72_0.15_85)]/30 cursor-pointer hover:bg-[oklch(0.72_0.15_85)]/25 transition-colors"
              onDoubleClick={() => openEdit(e)}
              title="Double-click to edit"
            >
              {e.summary}
            </span>
          ))}
        </div>
      )}

      {/* Add event hint */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/50">
        <p className="text-[11px] text-muted-foreground">
          Click grid to add · Drag to move · Double-click to edit
        </p>
        <button
          onClick={() => openNew()}
          className="flex items-center gap-1 text-[11px] text-[oklch(0.55_0.12_85)] hover:text-[oklch(0.72_0.15_85)] transition-colors"
        >
          <Plus className="h-3 w-3" /> Add event
        </button>
      </div>

      {/* Time grid */}
      <div className="flex-1 overflow-y-auto">
        <div
          className="flex"
          style={{ height: `${totalGridHeight}px` }}
          onMouseMove={onMouseMove}
        >
          {/* Hour labels */}
          <div className="w-12 shrink-0 relative select-none" style={{ height: `${totalGridHeight}px` }}>
            {HOURS.map((h) => (
              <div
                key={h}
                className="absolute right-2 text-[10px] text-muted-foreground/70 -translate-y-2"
                style={{ top: `${(h - GRID_START_H) * HOUR_HEIGHT}px` }}
              >
                {String(h).padStart(2, "0")}:00
              </div>
            ))}
          </div>

          {/* Event grid */}
          <div
            ref={gridRef}
            className="flex-1 relative cursor-crosshair"
            style={{ height: `${totalGridHeight}px` }}
            onClick={handleGridClick}
          >
            {/* Hour lines */}
            {HOURS.map((h) => (
              <div
                key={h}
                className="absolute left-0 right-0 border-t border-border/40"
                style={{ top: `${(h - GRID_START_H) * HOUR_HEIGHT}px` }}
              />
            ))}
            {/* Half-hour lines */}
            {HOURS.map((h) => (
              <div
                key={`${h}h`}
                className="absolute left-0 right-0 border-t border-border/20"
                style={{ top: `${(h - GRID_START_H) * HOUR_HEIGHT + HOUR_HEIGHT / 2}px` }}
              />
            ))}

            {/* Current time indicator */}
            <CurrentTimeIndicator />

            {/* Events */}
            {timedEvents.map((ev) => {
              const isDragging = drag?.eventId === ev.id;
              const pos = isDragging && dragPos ? dragPos : parseEventTimes(ev);
              return (
                <EventBlock
                  key={ev.id}
                  event={ev}
                  dragging={isDragging}
                  dragStartMin={pos.startMin}
                  dragEndMin={pos.endMin}
                  onDragStart={(e, id) => startDrag(e, id, "move")}
                  onResizeStart={(e, id) => startDrag(e, id, "resize")}
                  onDoubleClick={openEdit}
                />
              );
            })}
          </div>
        </div>
      </div>

      {/* Edit / Create modal */}
      {editState && (
        <EditModal
          state={editState}
          onChange={(patch) => setEditState((s) => s ? { ...s, ...patch } : s)}
          onClose={() => setEditState(null)}
          onSave={handleSave}
          onDelete={handleDelete}
          saving={saving}
          deleting={deleting}
        />
      )}
    </div>
  );
}

// ─── CurrentTimeIndicator ─────────────────────────────────────────────────────
function CurrentTimeIndicator() {
  const [min, setMin] = useState(() => {
    const n = new Date();
    return n.getHours() * 60 + n.getMinutes();
  });

  useEffect(() => {
    const id = setInterval(() => {
      const n = new Date();
      setMin(n.getHours() * 60 + n.getMinutes());
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  if (min < GRID_START_H * 60 || min > GRID_END_H * 60) return null;
  const top = (min - GRID_START_H * 60) * PX_PER_MIN;

  return (
    <div className="absolute left-0 right-0 z-30 pointer-events-none" style={{ top: `${top}px` }}>
      <div className="flex items-center gap-1">
        <div className="w-2 h-2 rounded-full bg-red-500 shrink-0 -ml-1" />
        <div className="flex-1 h-px bg-red-500/70" />
      </div>
    </div>
  );
}
