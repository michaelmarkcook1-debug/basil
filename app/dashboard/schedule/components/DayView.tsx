"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  X, Trash2, Video, Users, Save, Loader2, Plus, Pencil,
  MapPin, Clock, ExternalLink, Copy, Check, ChevronDown, ChevronUp,
  CheckCircle2, XCircle, HelpCircle,
} from "lucide-react";

// ─── Constants ────────────────────────────────────────────────────────────────
const HOUR_HEIGHT    = 80;          // px per hour
const PX_PER_MIN     = HOUR_HEIGHT / 60;
const GRID_START_H   = 7;           // 07:00
const GRID_END_H     = 21;          // 21:00
const SNAP_MINUTES   = 15;
const MIN_DURATION   = 15;          // minimum event duration in minutes
const DRAG_THRESHOLD = 5;           // px of movement before drag activates

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
  return h * 60 + (m || 0);
}
function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
function initials(name: string): string {
  return name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
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
  location?: string;
  description?: string;
  videoLink?: string;
  isOrganizer?: boolean;
  myResponseStatus?: "accepted" | "declined" | "tentative" | "needsAction";
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

// Palette for attendee avatars
const AVATAR_COLORS = [
  "bg-blue-500/20 text-blue-600 dark:text-blue-300",
  "bg-violet-500/20 text-violet-600 dark:text-violet-300",
  "bg-emerald-500/20 text-emerald-600 dark:text-emerald-300",
  "bg-amber-500/20 text-amber-700 dark:text-amber-300",
  "bg-rose-500/20 text-rose-600 dark:text-rose-300",
  "bg-cyan-500/20 text-cyan-600 dark:text-cyan-300",
];

function avatarColor(index: number) {
  return AVATAR_COLORS[index % AVATAR_COLORS.length];
}

function isVideoProvider(link: string): "zoom" | "meet" | "teams" | "other" {
  if (link.includes("zoom.us")) return "zoom";
  if (link.includes("meet.google.com")) return "meet";
  if (link.includes("teams.microsoft.com")) return "teams";
  return "other";
}

// ─── EventBlock ───────────────────────────────────────────────────────────────
function EventBlock({
  event,
  dragging,
  dragStartMin,
  dragEndMin,
  onDragStart,
  onResizeStart,
}: {
  event: DayEvent;
  dragging: boolean;
  dragStartMin: number;
  dragEndMin: number;
  onDragStart: (e: React.MouseEvent, id: string) => void;
  onResizeStart: (e: React.MouseEvent, id: string) => void;
}) {
  const { startMin, endMin } = parseEventTimes(event);
  const displayStart = dragging ? dragStartMin : startMin;
  const displayEnd   = dragging ? dragEndMin   : endMin;
  const top    = eventTop(displayStart);
  const height = eventHeight(displayStart, displayEnd);

  let bg   = "bg-[oklch(0.72_0.15_85)]/20 border-[oklch(0.72_0.15_85)]/50";
  let text = "text-[oklch(0.4_0.1_85)] dark:text-[oklch(0.8_0.12_85)]";
  const lower = event.summary.toLowerCase();
  if (lower.includes("focus") || lower.includes("deep work")) {
    bg   = "bg-blue-500/10 border-blue-400/40";
    text = "text-blue-700 dark:text-blue-300";
  } else if (lower.includes("lunch") || lower.includes("break")) {
    bg   = "bg-emerald-500/10 border-emerald-400/40";
    text = "text-emerald-700 dark:text-emerald-300";
  }

  return (
    <div
      className={`absolute left-0 right-2 rounded-md border px-2 py-1 select-none group
        ${bg} ${dragging ? "opacity-70 shadow-lg ring-2 ring-[oklch(0.72_0.15_85)] z-20" : "hover:shadow-md hover:brightness-105 z-10"}
        transition-all cursor-pointer active:cursor-grabbing`}
      style={{ top: `${top}px`, height: `${height}px`, minHeight: `${MIN_DURATION * PX_PER_MIN}px` }}
      onMouseDown={(e) => { e.stopPropagation(); onDragStart(e, event.id); }}
    >
      {/* Pencil icon hint on hover */}
      <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-50 transition-opacity pointer-events-none">
        <Pencil className="h-2.5 w-2.5 text-current" />
      </div>

      <div className="flex items-start gap-1 overflow-hidden h-full pr-4">
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

// ─── EventDetailPopover ───────────────────────────────────────────────────────
function EventDetailPopover({
  event,
  onClose,
  onEdit,
  onDelete,
  onRsvp,
  deleting,
}: {
  event: DayEvent;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onRsvp: (status: "accepted" | "declined" | "tentative") => Promise<void>;
  deleting: boolean;
}) {
  const { startMin, endMin } = parseEventTimes(event);
  const dur = endMin - startMin;
  const [copied, setCopied] = useState(false);
  const [descExpanded, setDescExpanded] = useState(false);
  const [rsvping, setRsvping] = useState(false);
  const [rsvpStatus, setRsvpStatus] = useState(event.myResponseStatus ?? "needsAction");
  const isOrganizer = event.isOrganizer ?? true;

  async function handleRsvp(status: "accepted" | "declined" | "tentative") {
    setRsvping(true);
    await onRsvp(status);
    setRsvpStatus(status);
    setRsvping(false);
  }

  const provider = event.videoLink ? isVideoProvider(event.videoLink) : null;
  const videoLabel = provider === "zoom" ? "Join Zoom" : provider === "meet" ? "Join Meet" : provider === "teams" ? "Join Teams" : "Join Call";

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  function copyLink() {
    if (!event.videoLink) return;
    navigator.clipboard.writeText(event.videoLink).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const descLines = event.description?.split("\n").filter(Boolean) ?? [];
  const shortDesc = descLines.slice(0, 3).join(" ").slice(0, 200);
  const hasMoreDesc = descLines.length > 3 || (event.description?.length ?? 0) > 200;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" onClick={onClose} />

      {/* Popover card */}
      <div className="relative w-full max-w-sm bg-card border border-border rounded-xl shadow-2xl overflow-hidden">
        {/* Colour accent bar */}
        <div className="h-1 w-full bg-[oklch(0.72_0.15_85)]" />

        <div className="p-5 space-y-4">
          {/* Header */}
          <div className="flex items-start justify-between gap-3">
            <h3 className="font-semibold text-base leading-snug flex-1 pr-2">
              {event.summary}
            </h3>
            <div className="flex items-center gap-1 shrink-0">
              {/* Organizer: Edit + Delete. Invitee: no edit/delete */}
              {isOrganizer && (
                <>
                  <button
                    onClick={onEdit}
                    className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                    title="Edit event"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={onDelete}
                    disabled={deleting}
                    className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                    title="Cancel event"
                  >
                    {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </button>
                </>
              )}
              <button
                onClick={onClose}
                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                title="Close"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* RSVP row — only for events where user is an invitee */}
          {!isOrganizer && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Your response</p>
              <div className="flex gap-2">
                {(["accepted", "tentative", "declined"] as const).map((s) => {
                  const active = rsvpStatus === s;
                  const cfg = {
                    accepted:  { label: "Accept",   icon: CheckCircle2, active: "bg-emerald-500 text-white border-emerald-500", hover: "hover:bg-emerald-50 hover:border-emerald-400 hover:text-emerald-700" },
                    tentative: { label: "Maybe",    icon: HelpCircle,   active: "bg-amber-400 text-white border-amber-400",    hover: "hover:bg-amber-50 hover:border-amber-400 hover:text-amber-700" },
                    declined:  { label: "Decline",  icon: XCircle,      active: "bg-red-500 text-white border-red-500",        hover: "hover:bg-red-50 hover:border-red-400 hover:text-red-700" },
                  }[s];
                  const Icon = cfg.icon;
                  return (
                    <button
                      key={s}
                      disabled={rsvping}
                      onClick={() => handleRsvp(s)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors disabled:opacity-50
                        ${active ? cfg.active : `border-border text-muted-foreground ${cfg.hover}`}`}
                    >
                      {rsvping && rsvpStatus !== s ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Icon className="h-3.5 w-3.5" />
                      )}
                      {cfg.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Time */}
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Clock className="h-4 w-4 shrink-0 text-[oklch(0.72_0.15_85)]" />
            <span>
              {minToTime(startMin)} – {minToTime(endMin)}
              <span className="ml-1.5 text-xs opacity-70">({durationLabel(dur)})</span>
            </span>
          </div>

          {/* Location */}
          {event.location && !event.videoLink && (
            <div className="flex items-start gap-2 text-sm text-muted-foreground">
              <MapPin className="h-4 w-4 shrink-0 mt-0.5 text-[oklch(0.72_0.15_85)]" />
              <span className="leading-snug">{event.location}</span>
            </div>
          )}

          {/* Video call join button */}
          {event.videoLink && (
            <div className="flex items-center gap-2">
              <a
                href={event.videoLink}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 flex items-center justify-center gap-1.5 h-9 rounded-md text-sm font-medium
                  bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)] hover:bg-[oklch(0.78_0.12_85)] transition-colors"
              >
                <Video className="h-4 w-4" />
                {videoLabel}
                <ExternalLink className="h-3 w-3 opacity-70" />
              </a>
              <button
                onClick={copyLink}
                className="h-9 w-9 flex items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                title="Copy link"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
          )}

          {/* Attendees */}
          {event.attendees.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                <Users className="h-3 w-3" />
                {event.attendees.length} {event.attendees.length === 1 ? "attendee" : "attendees"}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {event.attendees.slice(0, 8).map((name, i) => (
                  <div
                    key={i}
                    className={`flex items-center gap-1.5 rounded-full pl-0.5 pr-2.5 py-0.5 text-xs font-medium ${avatarColor(i)}`}
                    title={name}
                  >
                    <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold shrink-0 ${avatarColor(i)}`}>
                      {initials(name)}
                    </span>
                    <span className="truncate max-w-[120px]">{name}</span>
                  </div>
                ))}
                {event.attendees.length > 8 && (
                  <div className="flex items-center gap-1 text-xs text-muted-foreground px-2 py-0.5">
                    +{event.attendees.length - 8} more
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Description */}
          {descLines.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground leading-relaxed">
                {descExpanded ? event.description : shortDesc}
                {!descExpanded && hasMoreDesc && "…"}
              </p>
              {hasMoreDesc && (
                <button
                  onClick={() => setDescExpanded(!descExpanded)}
                  className="flex items-center gap-0.5 text-[11px] text-[oklch(0.55_0.12_85)] hover:text-[oklch(0.72_0.15_85)] transition-colors"
                >
                  {descExpanded ? <><ChevronUp className="h-3 w-3" /> Show less</> : <><ChevronDown className="h-3 w-3" /> Show more</>}
                </button>
              )}
            </div>
          )}
        </div>
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
  const endMin  = timeToMin(state.startTime) + state.durationMin;
  const endTime = minToTime(clamp(endMin, 0, 23 * 60 + 59));

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md bg-card border border-border rounded-xl shadow-2xl p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-base">
            {isNew ? "New Event" : "Edit Event"}
          </h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

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

        <div className="space-y-1.5">
          <Label htmlFor="ev-attendees" className="text-xs font-medium">
            Attendees <span className="text-muted-foreground font-normal">(emails, comma-separated)</span>
          </Label>
          <Input
            id="ev-attendees"
            value={state.attendees}
            onChange={(e) => onChange({ attendees: e.target.value })}
            placeholder="alice@co.com, bob@co.com"
            className="h-9 text-sm"
          />
        </div>

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
  date: string;
  events: DayEvent[];
  onRefresh: () => void;
}) {
  const gridRef          = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const hasDragged       = useRef(false);
  const [drag, setDrag]  = useState<DragState | null>(null);
  const [dragPos, setDragPos]   = useState<{ startMin: number; endMin: number } | null>(null);
  const [editState, setEditState] = useState<EditState | null>(null);
  const [detailEvent, setDetailEvent] = useState<DayEvent | null>(null);
  const [saving, setSaving]     = useState(false);
  const [deleting, setDeleting] = useState(false);

  // ── Open detail popover ───────────────────────────────────────────────────
  const openDetail = useCallback((event: DayEvent) => {
    setDetailEvent(event);
  }, []);

  // ── Edit modal helpers ─────────────────────────────────────────────────────
  const openEdit = useCallback((event: DayEvent) => {
    const { startMin, endMin } = parseEventTimes(event);
    setDetailEvent(null);
    setEditState({
      eventId: event.id,
      title: event.summary,
      date,
      startTime: minToTime(startMin),
      durationMin: Math.max(MIN_DURATION, endMin - startMin),
      attendees: event.attendees.join(", "),
    });
  }, [date]);

  const openNew = useCallback((clickMin?: number) => {
    setDetailEvent(null);
    const startMin = clamp(
      snapMin(clickMin ?? 9 * 60),
      GRID_START_H * 60,
      GRID_END_H * 60 - 30,
    );
    setEditState({
      eventId: null,
      title: "",
      date,
      startTime: minToTime(startMin),
      durationMin: 30,
      attendees: "",
    });
  }, [date]);

  // ── Drag helpers ───────────────────────────────────────────────────────────
  const startDrag = useCallback((e: React.MouseEvent, eventId: string, type: "move" | "resize") => {
    if (e.button !== 0) return;
    const ev = events.find((x) => x.id === eventId);
    if (!ev) return;
    const { startMin, endMin } = parseEventTimes(ev);
    hasDragged.current = false;
    setDrag({ eventId, type, startY: e.clientY, origStartMin: startMin, origEndMin: endMin });
    setDragPos({ startMin, endMin });
    e.preventDefault();
  }, [events]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!drag) return;
    const deltaY = e.clientY - drag.startY;

    // Only activate drag visuals after threshold to allow click-to-open-detail
    if (Math.abs(deltaY) > DRAG_THRESHOLD) hasDragged.current = true;
    if (!hasDragged.current) return;

    const deltaMin = snapMin(deltaY / PX_PER_MIN);
    if (drag.type === "move") {
      const dur      = drag.origEndMin - drag.origStartMin;
      const newStart = clamp(drag.origStartMin + deltaMin, GRID_START_H * 60, GRID_END_H * 60 - dur);
      setDragPos({ startMin: newStart, endMin: newStart + dur });
    } else {
      const newEnd = clamp(drag.origEndMin + deltaMin, drag.origStartMin + MIN_DURATION, GRID_END_H * 60);
      setDragPos({ startMin: drag.origStartMin, endMin: snapMin(newEnd) });
    }
  }, [drag]);

  const onMouseUp = useCallback(async () => {
    if (!drag) { setDragPos(null); return; }

    // ── Click (no movement) → open detail popover ────────────────────────────
    if (!hasDragged.current) {
      const ev = events.find((x) => x.id === drag.eventId);
      setDrag(null);
      setDragPos(null);
      if (ev && drag.type === "move") openDetail(ev);
      return;
    }

    // ── Drag ended → save new position ───────────────────────────────────────
    if (!dragPos) { setDrag(null); setDragPos(null); return; }
    const ev = events.find((x) => x.id === drag.eventId);
    if (!ev) { setDrag(null); setDragPos(null); return; }

    const { startMin: origStart, endMin: origEnd } = parseEventTimes(ev);
    const noChange = dragPos.startMin === origStart && dragPos.endMin === origEnd;
    const savedDrag = { ...drag };
    const savedPos  = { ...dragPos };
    setDrag(null);
    setDragPos(null);

    if (noChange) return;

    try {
      await fetch(`/api/calendar/${savedDrag.eventId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startTime: minToTime(savedPos.startMin),
          duration:  savedPos.endMin - savedPos.startMin,
        }),
      });
      onRefresh();
    } catch {
      // silent — event snaps back on refresh
    }
  }, [drag, dragPos, events, openDetail, onRefresh]);

  // ── Save / delete handlers ─────────────────────────────────────────────────
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
            title:     editState.title,
            date:      editState.date,
            startTime: editState.startTime,
            duration:  editState.durationMin,
            attendees: attendeeList,
          }),
        });
      } else {
        await fetch("/api/calendar/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title:     editState.title,
            date:      editState.date,
            startTime: editState.startTime,
            duration:  editState.durationMin,
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

  const handleDelete = async (eventId?: string) => {
    const id = eventId ?? editState?.eventId;
    if (!id) return;
    setDeleting(true);
    try {
      await fetch(`/api/calendar/${id}`, { method: "DELETE" });
      setEditState(null);
      setDetailEvent(null);
      onRefresh();
    } finally {
      setDeleting(false);
    }
  };

  // Grid click → create new event (only fires if no drag is in progress)
  const handleGridClick = (e: React.MouseEvent) => {
    if (drag) return;
    const rect = gridRef.current?.getBoundingClientRect();
    if (!rect) return;
    const clickMin = snapMin(GRID_START_H * 60 + (e.clientY - rect.top) / PX_PER_MIN);
    openNew(clickMin);
  };

  // Listen for mouseup globally so drag completes even if cursor leaves the grid
  useEffect(() => {
    if (!drag) return;
    const up = () => { onMouseUp(); };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, [drag, onMouseUp]);

  // Scroll to current time (or 08:00) when the day is first displayed
  useEffect(() => {
    const sc = scrollContainerRef.current;
    if (!sc) return;
    const now = new Date();
    const currentMin = now.getHours() * 60 + now.getMinutes();
    const targetMin = Math.max(GRID_START_H * 60, currentMin - 60); // 1h before now
    const scrollTop = (targetMin - GRID_START_H * 60) * PX_PER_MIN;
    sc.scrollTop = scrollTop;
  }, [date]); // re-scroll when selected date changes

  // We only expect timed events from the parent (all-day events are tasks, not meetings)
  const timedEvents = events.filter((e) => !e.isAllDay);
  const totalGridHeight = (GRID_END_H - GRID_START_H) * HOUR_HEIGHT;

  return (
    <div className="flex flex-col" style={{ height: "100%" }}>
      {/* Hint bar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/50 shrink-0">
        <p className="text-[11px] text-muted-foreground">
          Click to view · Drag to move · Drag bottom edge to resize
        </p>
        <button
          onClick={() => openNew()}
          className="flex items-center gap-1 text-[11px] text-[oklch(0.55_0.12_85)] hover:text-[oklch(0.72_0.15_85)] transition-colors"
        >
          <Plus className="h-3 w-3" /> Add event
        </button>
      </div>

      {/* Time grid */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto min-h-0">
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
                />
              );
            })}
          </div>
        </div>
      </div>

      {/* Event Detail Popover */}
      {detailEvent && (
        <EventDetailPopover
          event={detailEvent}
          onClose={() => setDetailEvent(null)}
          onEdit={() => openEdit(detailEvent)}
          onDelete={() => handleDelete(detailEvent.id)}
          onRsvp={async (status) => {
            await fetch(`/api/calendar/${detailEvent.id}/rsvp`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status }),
            });
            onRefresh();
          }}
          deleting={deleting}
        />
      )}

      {/* Edit / Create modal */}
      {editState && (
        <EditModal
          state={editState}
          onChange={(patch) => setEditState((s) => s ? { ...s, ...patch } : s)}
          onClose={() => setEditState(null)}
          onSave={handleSave}
          onDelete={() => handleDelete()}
          saving={saving}
          deleting={deleting}
        />
      )}
    </div>
  );
}

// ─── CurrentTimeIndicator ─────────────────────────────────────────────────────
function CurrentTimeIndicator() {
  // Start null to avoid SSR/client hydration mismatch (React #418):
  // new Date() on server produces a different minute than on the client.
  const [min, setMin] = useState<number | null>(null);

  useEffect(() => {
    // Set immediately on mount (client-only), then update every minute
    const update = () => {
      const n = new Date();
      setMin(n.getHours() * 60 + n.getMinutes());
    };
    update();
    const id = setInterval(update, 60_000);
    return () => clearInterval(id);
  }, []);

  if (min === null || min < GRID_START_H * 60 || min > GRID_END_H * 60) return null;
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
