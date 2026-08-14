"use client";

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import Link from "next/link";
import {
  X, Trash2, Video, Users, Save, Loader2, Plus, Pencil,
  MapPin, Clock, ExternalLink, Copy, Check, ChevronDown, ChevronUp,
  CheckCircle2, XCircle, HelpCircle, Send, Forward, Sparkles,
  Link as LinkIcon, CalendarSearch,
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
  /** When true, Google Calendar auto-generates a Meet link on create. */
  addVideoCall: boolean;
  /** Optional explicit conferencing URL (Zoom/Teams personal room paste). */
  videoLink: string;
}

interface ContactOption {
  id: string;
  name: string;
  email: string;
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
  "bg-signal-info-subtle text-signal-info",
  "bg-signal-info-subtle text-signal-info",
  "bg-signal-positive-subtle text-signal-positive",
  "bg-signal-warning-subtle text-signal-warning",
  "bg-signal-critical-subtle text-signal-critical",
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
  onEventClick,
}: {
  event: DayEvent;
  dragging: boolean;
  dragStartMin: number;
  dragEndMin: number;
  onDragStart: (e: React.MouseEvent, id: string) => void;
  onResizeStart: (e: React.MouseEvent, id: string) => void;
  onEventClick: (event: DayEvent) => void;
}) {
  const { startMin, endMin } = parseEventTimes(event);
  const displayStart = dragging ? dragStartMin : startMin;
  const displayEnd   = dragging ? dragEndMin   : endMin;
  const top    = eventTop(displayStart);
  const height = eventHeight(displayStart, displayEnd);

  let bg   = "bg-[var(--w-carbon-tint)] border-[var(--w-rule)]";
  let text = "text-[oklch(0.4_0.1_85)] dark:text-[oklch(0.8_0.12_85)]";
  const lower = event.summary.toLowerCase();
  if (lower.includes("focus") || lower.includes("deep work")) {
    bg   = "bg-signal-info-subtle border-signal-info-border/40";
    text = "text-signal-info";
  } else if (lower.includes("lunch") || lower.includes("break")) {
    bg   = "bg-signal-positive-subtle border-signal-positive-border/40";
    text = "text-signal-positive";
  }

  return (
    <div
      className={`absolute left-0 right-2 rounded-md border px-2 py-1 select-none group
        ${bg} ${dragging ? "opacity-70 shadow-lg ring-2 ring-gold z-20" : "hover:shadow-md hover:brightness-105 z-10"}
        transition-all cursor-pointer active:cursor-grabbing`}
      style={{ top: `${top}px`, height: `${height}px`, minHeight: `${MIN_DURATION * PX_PER_MIN}px` }}
      // Button semantics: this was a bare <div onClick>, so every event on the
      // calendar was unreachable without a mouse. Drag stays mouse-only (a
      // separate concern), but OPENING an event must not require one.
      role="button"
      tabIndex={0}
      aria-label={`${event.summary}, ${minToTime(displayStart)} to ${minToTime(displayEnd)}`}
      onMouseDown={(e) => { e.stopPropagation(); onDragStart(e, event.id); }}
      // Stop the click bubbling to the grid (which would open the "New event"
      // modal). The parent decides whether this was a click or the tail of a drag.
      onClick={(e) => { e.stopPropagation(); onEventClick(event); }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault(); // Space would scroll the day grid
          e.stopPropagation();
          onEventClick(event);
        }
      }}
    >
      {/* Pencil icon hint on hover */}
      <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-60 transition-opacity pointer-events-none">
        <Pencil className="h-3 w-3 text-current" />
      </div>

      <div className="flex items-start gap-1 overflow-hidden h-full pr-4">
        <div className="flex-1 min-w-0">
          <p className={`text-[13px] font-semibold leading-tight truncate ${text}`}>
            {event.summary}
          </p>
          {height >= 36 && (
            <p className="text-xs text-muted-foreground leading-tight">
              {minToTime(displayStart)} – {minToTime(displayEnd)}
            </p>
          )}
          {height >= 52 && event.attendees.length > 0 && (
            <p className="text-xs text-muted-foreground truncate flex items-center gap-0.5 mt-0.5">
              <Users className="h-2.5 w-2.5 inline shrink-0" />
              {event.attendees.slice(0, 2).join(", ")}
              {event.attendees.length > 2 && ` +${event.attendees.length - 2}`}
            </p>
          )}
        </div>
        {event.hasVideo && height >= 36 && (
          <Video className="h-3 w-3 text-signal-info shrink-0 mt-0.5" />
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

  // ── Reply state ─────────────────────────────────────────────────────────────
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyMessage, setReplyMessage] = useState("");
  const [replyAll, setReplyAll] = useState(false);
  const [replySending, setReplySending] = useState(false);
  const [replySent, setReplySent] = useState(false);

  // ── Forward state ───────────────────────────────────────────────────────────
  const [forwardOpen, setForwardOpen] = useState(false);
  const [forwardEmails, setForwardEmails] = useState("");
  const [forwarding, setForwarding] = useState(false);
  const [forwardDone, setForwardDone] = useState(false);
  // These three actions all reported SUCCESS on failure: "Sent ✓" / "Forwarded"
  // when the organiser received nothing, and an RSVP that turned green while the
  // organiser saw no response. Worse, they cleared the user's typed message on a
  // failed send. Nothing is claimed now unless the server confirmed it.
  const [actionError, setActionError] = useState("");

  async function handleReply() {
    if (!replyMessage.trim()) return;
    setReplySending(true);
    setActionError("");
    try {
      // fetch() does not reject on 5xx — without this check the UI showed
      // "Sent ✓" and wiped the message the user had typed.
      const res = await fetch(`/api/calendar/${event.id}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: replyMessage, replyAll }),
      });
      if (!res.ok) throw new Error(`Reply failed (${res.status})`);
      setReplySent(true);
      setReplyMessage(""); // only after the server confirmed it
      setTimeout(() => { setReplySent(false); setReplyOpen(false); }, 2000);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Reply failed — the organiser did not receive it.");
    } finally {
      setReplySending(false);
    }
  }

  async function handleForward() {
    const emails = forwardEmails.split(/[,;\s]+/).map((e) => e.trim()).filter(Boolean);
    if (emails.length === 0) return;
    setForwarding(true);
    setActionError("");
    try {
      const res = await fetch(`/api/calendar/${event.id}/forward`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emails }),
      });
      if (!res.ok) throw new Error(`Forward failed (${res.status})`);
      setForwardDone(true);
      setForwardEmails(""); // only after the server confirmed it
      setTimeout(() => { setForwardDone(false); setForwardOpen(false); }, 2000);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Forward failed — nothing was sent.");
    } finally {
      setForwarding(false);
    }
  }

  async function handleRsvp(status: "accepted" | "declined" | "tentative") {
    setRsvping(true);
    setActionError("");
    try {
      await onRsvp(status);
      setRsvpStatus(status); // only reflect the new state if the call succeeded
    } catch (err) {
      // Previously there was no catch AND no finally: a throw left all three
      // RSVP buttons permanently disabled, with the organiser none the wiser.
      setActionError(err instanceof Error ? err.message : "RSVP failed — the organiser was not notified.");
    } finally {
      setRsvping(false);
    }
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
        <div className="h-1 w-full bg-[var(--w-carbon)]" />

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
                    aria-label="Edit event"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={onDelete}
                    disabled={deleting}
                    className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                    title="Cancel event"
                    aria-label="Cancel event"
                  >
                    {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </button>
                </>
              )}
              <button
                onClick={onClose}
                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                title="Close"
                aria-label="Close"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* RSVP row — only for events where user is an invitee */}
          {/* Shared failure notice for RSVP / reply / forward. Without this the
              error state would exist but never reach the user — the same silent
              failure in a new costume. role=alert so it is announced. */}
          {actionError && (
            <p
              role="alert"
              className="rounded-md border border-signal-critical-border bg-signal-critical-subtle px-3 py-2 text-xs text-signal-critical"
            >
              {actionError}
            </p>
          )}

          {!isOrganizer && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Your response</p>
              <div className="flex gap-2">
                {(["accepted", "tentative", "declined"] as const).map((s) => {
                  const active = rsvpStatus === s;
                  const cfg = {
                    accepted:  { label: "Accept",   icon: CheckCircle2, active: "bg-signal-positive text-white border-signal-positive", hover: "hover:bg-signal-positive-subtle hover:border-signal-positive-border hover:text-signal-positive" },
                    tentative: { label: "Maybe",    icon: HelpCircle,   active: "bg-signal-warning text-white border-signal-warning-border",    hover: "hover:bg-signal-warning-subtle hover:border-signal-warning-border hover:text-signal-warning" },
                    declined:  { label: "Decline",  icon: XCircle,      active: "bg-signal-critical text-white border-signal-critical",        hover: "hover:bg-signal-critical-subtle hover:border-signal-critical-border hover:text-signal-critical" },
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
            <Clock className="h-4 w-4 shrink-0 text-[var(--w-carbon)]" />
            <span>
              {minToTime(startMin)} – {minToTime(endMin)}
              <span className="ml-1.5 text-xs opacity-70">({durationLabel(dur)})</span>
            </span>
          </div>

          {/* Location */}
          {event.location && !event.videoLink && (
            <div className="flex items-start gap-2 text-sm text-muted-foreground">
              <MapPin className="h-4 w-4 shrink-0 mt-0.5 text-[var(--w-carbon)]" />
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
                  bg-[var(--w-carbon)] text-white hover:bg-[oklch(0.78_0.12_85)] transition-colors"
              >
                <Video className="h-4 w-4" />
                {videoLabel}
                <ExternalLink className="h-3 w-3 opacity-70" />
              </a>
              <button
                onClick={copyLink}
                className="h-9 w-9 flex items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                title="Copy link"
                aria-label="Copy meeting link"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-signal-positive" /> : <Copy className="h-3.5 w-3.5" />}
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
                  className="flex items-center gap-0.5 text-xs text-[oklch(0.55_0.12_85)] hover:text-[var(--w-carbon)] transition-colors"
                >
                  {descExpanded ? <><ChevronUp className="h-3 w-3" /> Show less</> : <><ChevronDown className="h-3 w-3" /> Show more</>}
                </button>
              )}
            </div>
          )}

          {/* ── Action bar ──────────────────────────────────────────────── */}
          <div className="border-t border-border/50 pt-3 space-y-2.5">

            {/* Create brief button */}
            <Link
              href={`/dashboard/meetings/${event.id}`}
              onClick={onClose}
              className="flex items-center justify-center gap-2 w-full h-9 rounded-md text-sm font-medium
                bg-[var(--w-carbon-tint)] text-[oklch(0.55_0.12_85)] border border-[var(--w-rule)]
                hover:bg-[var(--w-carbon-tint)] transition-colors"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Create meeting brief
            </Link>

            {/* Reply section */}
            <div>
              <button
                onClick={() => { setReplyOpen((v) => !v); setForwardOpen(false); }}
                className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors w-full"
              >
                <Send className="h-3.5 w-3.5" />
                Reply to organiser
                {replyOpen ? <ChevronUp className="h-3 w-3 ml-auto" /> : <ChevronDown className="h-3 w-3 ml-auto" />}
              </button>
              {replyOpen && (
                <div className="mt-2 space-y-2">
                  <textarea
                    value={replyMessage}
                    onChange={(e) => setReplyMessage(e.target.value)}
                    autoFocus
                    rows={3}
                    placeholder="Type your message…"
                    className="w-full text-sm rounded-md border border-border bg-muted/30 px-3 py-2
                      outline-none resize-none focus:ring-2 focus:ring-[var(--w-rule)]
                      placeholder:text-muted-foreground/40"
                  />
                  <div className="flex items-center justify-between gap-2">
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                      <input
                        type="checkbox"
                        checked={replyAll}
                        onChange={(e) => setReplyAll(e.target.checked)}
                        className="rounded"
                      />
                      Reply all
                    </label>
                    <button
                      onClick={handleReply}
                      disabled={replySending || !replyMessage.trim()}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium
                        bg-[var(--w-carbon)] text-white
                        hover:bg-[oklch(0.78_0.12_85)] disabled:opacity-50 transition-colors"
                    >
                      {replySent ? <><Check className="h-3 w-3" /> Sent</> : replySending ? <Loader2 className="h-3 w-3 animate-spin" /> : <><Send className="h-3 w-3" /> Send</>}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Forward section */}
            <div>
              <button
                onClick={() => { setForwardOpen((v) => !v); setReplyOpen(false); }}
                className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors w-full"
              >
                <Forward className="h-3.5 w-3.5" />
                Forward invite
                {forwardOpen ? <ChevronUp className="h-3 w-3 ml-auto" /> : <ChevronDown className="h-3 w-3 ml-auto" />}
              </button>
              {forwardOpen && (
                <div className="mt-2 space-y-2">
                  <input
                    type="text"
                    value={forwardEmails}
                    onChange={(e) => setForwardEmails(e.target.value)}
                    autoFocus
                    placeholder="email@example.com, another@example.com"
                    className="w-full text-sm rounded-md border border-border bg-muted/30 px-3 py-1.5
                      outline-none focus:ring-2 focus:ring-[var(--w-rule)]
                      placeholder:text-muted-foreground/40"
                  />
                  <p className="text-xs text-muted-foreground">Separate multiple addresses with commas</p>
                  <button
                    onClick={handleForward}
                    disabled={forwarding || !forwardEmails.trim()}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium
                      border border-border text-muted-foreground hover:text-foreground hover:bg-accent
                      disabled:opacity-50 transition-colors"
                  >
                    {forwardDone ? <><Check className="h-3 w-3 text-signal-positive" /> Forwarded</> : forwarding ? <Loader2 className="h-3 w-3 animate-spin" /> : <><Forward className="h-3 w-3" /> Forward</>}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── EditModal ────────────────────────────────────────────────────────────────
// ─── AttendeesAutocomplete ────────────────────────────────────────────────────
/**
 * Attendees input with contact-email autocomplete.
 *
 * Holds the raw comma-separated string the user is typing. As they type into
 * the active token, matching contacts from /api/contacts/all surface in a
 * dropdown. Selecting one replaces the current token with `Name <email>` and
 * appends a trailing ", " ready for the next entry.
 *
 * The dropdown only opens when there is at least 1 character in the active
 * token and at least 1 match — never noisy.
 */
function AttendeesAutocomplete({
  value,
  onChange,
  contacts,
}: {
  value: string;
  onChange: (next: string) => void;
  contacts: ContactOption[];
}) {
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Split on commas; the LAST segment is the token currently being typed.
  // Everything before it is "committed" (already chosen / typed) attendees.
  const segments = value.split(",");
  const committed = segments.slice(0, -1).join(",");
  const activeRaw = segments[segments.length - 1] ?? "";
  const activeToken = activeRaw.trim().toLowerCase();

  // Pull email out of "Name <email>" form, or accept a bare email/typed text.
  function extractEmail(token: string): string {
    const m = token.match(/<([^>]+)>/);
    return (m ? m[1] : token).trim().toLowerCase();
  }

  // Emails already in the field — exclude them from suggestions.
  const alreadyEmails = new Set(
    segments.slice(0, -1).map((s) => extractEmail(s)).filter(Boolean)
  );

  const matches = activeToken.length === 0
    ? []
    : contacts
        .filter((c) => c.email && !alreadyEmails.has(c.email.toLowerCase()))
        .filter((c) =>
          c.email.toLowerCase().includes(activeToken) ||
          c.name.toLowerCase().includes(activeToken)
        )
        .slice(0, 6);

  // Reset the highlighted row whenever the matches list changes shape.
  useEffect(() => { setHighlight(0); }, [activeToken]);

  function selectMatch(c: ContactOption) {
    // Replace the active token with the chosen contact and append ", " so the
    // user can immediately start the next one.
    const prefix = committed ? committed + ", " : "";
    onChange(`${prefix}${c.name} <${c.email}>, `);
    inputRef.current?.focus();
  }

  const showDropdown = focused && matches.length > 0;

  return (
    <div className="relative">
      <Input
        ref={inputRef}
        id="ev-attendees"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        // Blur is delayed so a mousedown on a dropdown row registers as a click.
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        onKeyDown={(e) => {
          if (!showDropdown) return;
          if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => Math.min(h + 1, matches.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
          else if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            selectMatch(matches[highlight]);
          } else if (e.key === "Escape") setFocused(false);
        }}
        placeholder="alice@co.com, bob@co.com"
        className="h-9 text-sm"
        autoComplete="off"
      />
      {showDropdown && (
        <div className="absolute z-10 mt-1 w-full rounded-md border border-border bg-popover shadow-lg overflow-hidden">
          {matches.map((c, i) => (
            <button
              key={c.id}
              type="button"
              // Use mousedown so the selection happens before the input blurs.
              onMouseDown={(e) => { e.preventDefault(); selectMatch(c); }}
              onMouseEnter={() => setHighlight(i)}
              className={cn(
                "w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-left transition-colors",
                i === highlight ? "bg-accent" : "hover:bg-accent/50"
              )}
            >
              <span className="font-medium truncate">{c.name}</span>
              <span className="text-xs text-muted-foreground truncate ml-2">{c.email}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── SmartSlotPicker ──────────────────────────────────────────────────────────
/**
 * "Find a time" picker: given the current attendees string + duration, calls
 * /api/calendar/freebusy to compute mutual free slots and presents them as
 * clickable chips. Selecting a chip fills the parent's `date` and `startTime`.
 *
 * Quietly degrades when no attendee emails are present, when Google isn't
 * connected, or when the API returns no slots.
 */
interface SlotSuggestionUI {
  start: string;
  end: string;
  label: string;
  attendeeLocalTimes: Array<{ name: string; localTime: string }>;
}

function SmartSlotPicker({
  attendeesValue,
  durationMin,
  onChoose,
}: {
  attendeesValue: string;
  durationMin: number;
  onChoose: (date: string, startTime: string) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [slots, setSlots] = useState<SlotSuggestionUI[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Extract bare emails from "Name <email>, Name <email>, …" or "a@b, c@d".
  const emails = useMemo(() => {
    const out: string[] = [];
    for (const segment of attendeesValue.split(",")) {
      const m = segment.match(/<([^>]+)>/);
      const candidate = (m ? m[1] : segment).trim();
      if (candidate.includes("@")) out.push(candidate.toLowerCase());
    }
    // Dedupe.
    return Array.from(new Set(out));
  }, [attendeesValue]);

  const findTimes = useCallback(async () => {
    if (emails.length === 0) return;
    setLoading(true);
    setError(null);
    setSlots(null);
    try {
      const res = await fetch("/api/calendar/freebusy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attendeeEmails: emails,
          durationMin,
          maxSlots: 6,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Couldn't fetch availability");
        setSlots([]);
        return;
      }
      setSlots(data.slots || []);
    } catch {
      setError("Network error fetching availability");
      setSlots([]);
    } finally {
      setLoading(false);
    }
  }, [emails, durationMin]);

  // Disable when no real emails present yet.
  const disabled = emails.length === 0 || loading;

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={findTimes}
        disabled={disabled}
        className="flex items-center gap-1.5 text-xs font-medium text-[oklch(0.55_0.12_85)] hover:text-[var(--w-carbon)] disabled:text-muted-foreground/40 disabled:cursor-not-allowed transition-colors"
        title={emails.length === 0 ? "Add an attendee email first" : "Check everyone's calendars"}
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <CalendarSearch className="h-3.5 w-3.5" />
        )}
        Find a time everyone is free
      </button>

      {/* Slot chips — only render once a query has run */}
      {slots !== null && (
        <div className="rounded-md border border-border/60 bg-muted/30 p-2 space-y-1.5">
          {error && (
            <p className="text-xs text-signal-warning">{error}</p>
          )}
          {slots.length === 0 && !error && (
            <p className="text-xs text-muted-foreground italic">
              No mutual free slots in the next 7 days — try a different duration or check the attendees&apos; tz.
            </p>
          )}
          {slots.length > 0 && (
            <>
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground/80 font-medium">
                Suggested times
              </p>
              <div className="flex flex-wrap gap-1.5">
                {slots.map((slot) => {
                  // Slot has UTC ISO start; surface date + HH:MM in local time.
                  const dt = new Date(slot.start);
                  const dateStr = dt.toISOString().slice(0, 10);
                  const startTime = dt.toLocaleTimeString("en-GB", {
                    hour: "2-digit",
                    minute: "2-digit",
                  });
                  const tooltip = slot.attendeeLocalTimes
                    .map((a) => `${a.localTime} — ${a.name}`)
                    .join("\n");
                  return (
                    <button
                      key={slot.start}
                      type="button"
                      onClick={() => onChoose(dateStr, startTime)}
                      title={tooltip}
                      className="inline-flex items-center gap-1.5 rounded-md border border-[var(--w-rule)] bg-[var(--w-carbon-tint)] hover:bg-[var(--w-carbon-tint)] px-2.5 py-1 text-xs font-medium text-[oklch(0.55_0.12_85)] transition-colors"
                    >
                      <Clock className="h-3 w-3" />
                      {slot.label}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function EditModal({
  state,
  onClose,
  onSave,
  onDelete,
  saving,
  deleting,
  contacts,
  onChange,
}: {
  state: EditState;
  onClose: () => void;
  onSave: () => void;
  onDelete: () => void;
  saving: boolean;
  deleting: boolean;
  contacts: ContactOption[];
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
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors" aria-label="Close">
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
            Attendees <span className="text-muted-foreground font-normal">(type to search your contacts)</span>
          </Label>
          <AttendeesAutocomplete
            value={state.attendees}
            onChange={(v) => onChange({ attendees: v })}
            contacts={contacts}
          />
        </div>

        {/* ── Smart slot picker — finds mutual free time across attendees ─── */}
        <SmartSlotPicker
          attendeesValue={state.attendees}
          durationMin={state.durationMin}
          onChoose={(date, startTime) => onChange({ date, startTime })}
        />

        {/* ── Video conferencing ───────────────────────────────────────────── */}
        <div className="space-y-2 pt-1">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={state.addVideoCall}
              onChange={(e) => onChange({ addVideoCall: e.target.checked })}
              className="h-4 w-4 rounded border-input accent-gold"
            />
            <Video className="h-3.5 w-3.5 text-[var(--w-carbon)]" />
            <span className="text-xs font-medium">Add video call</span>
            {!state.videoLink.trim() && state.addVideoCall && (
              <span className="text-xs text-muted-foreground">
                · Google Meet link will be generated
              </span>
            )}
          </label>

          {state.addVideoCall && (
            <div className="pl-6 space-y-1.5">
              <Label htmlFor="ev-videolink" className="text-xs font-medium text-muted-foreground">
                Or paste a Zoom / Teams link
              </Label>
              <div className="relative">
                <LinkIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  id="ev-videolink"
                  value={state.videoLink}
                  onChange={(e) => onChange({ videoLink: e.target.value })}
                  placeholder="https://zoom.us/j/…  (leave blank for Meet)"
                  className="h-9 pl-8 text-sm"
                />
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 pt-1">
          <Button
            onClick={onSave}
            disabled={saving || !state.title.trim()}
            className="flex-1 h-9 bg-[var(--w-carbon)] text-white hover:bg-[oklch(0.78_0.12_85)] gap-1.5"
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

  // Contacts for the attendees autocomplete in the edit/create modal.
  // Fetched once when the modal first opens — not on mount, to keep DayView
  // cheap when no edit is in flight.
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  useEffect(() => {
    if (!editState || contacts.length > 0) return;
    fetch("/api/contacts/all")
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        if (!d?.contacts) return;
        // Drop anyone without an email — they can't be invited.
        const opts: ContactOption[] = d.contacts
          .filter((c: { email?: string }) => !!c.email)
          .map((c: { id: string; name: string; email: string }) => ({
            id: c.id, name: c.name, email: c.email,
          }));
        setContacts(opts);
      })
      .catch(() => { /* autocomplete simply won't fire — input still works */ });
  }, [editState, contacts.length]);

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
      // Existing events already have whatever link they have — show it as a
      // pre-filled value so the user can clear or replace it.
      addVideoCall: !!event.videoLink,
      videoLink: event.videoLink ?? "",
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
      // Default to OFF — opt-in instead of auto-attaching a stale Zoom link.
      addVideoCall: false,
      videoLink: "",
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

  const updateDragFromY = useCallback((clientY: number) => {
    if (!drag) return;
    const deltaY = clientY - drag.startY;

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

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    updateDragFromY(e.clientY);
  }, [updateDragFromY]);

  const onMouseUp = useCallback(async () => {
    if (!drag) { setDragPos(null); return; }

    // ── Click (no movement) → handled by EventBlock's onClick, not here ──────
    // We only clear drag state; the synthetic click that follows opens the
    // detail popover (guarded by hasDragged so a real drag never opens it).
    if (!hasDragged.current) {
      setDrag(null);
      setDragPos(null);
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
        // Video-call resolution:
        //   - User pasted an explicit URL → send as zoomLink
        //   - User ticked "Add video call" with no URL → ask Google Meet auto-gen
        //   - Neither → no video attached (default)
        const trimmedLink = editState.videoLink.trim();
        await fetch("/api/calendar/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title:     editState.title,
            date:      editState.date,
            startTime: editState.startTime,
            duration:  editState.durationMin,
            attendees: attendeeList,
            ...(trimmedLink ? { zoomLink: trimmedLink } : {}),
            ...(editState.addVideoCall && !trimmedLink ? { addVideoCall: true } : {}),
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

  // While dragging, track move + up on the window so the drag keeps working
  // even when the cursor leaves the grid (fast drags, edge of screen).
  useEffect(() => {
    if (!drag) return;
    const move = (e: MouseEvent) => updateDragFromY(e.clientY);
    const up = () => { onMouseUp(); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [drag, onMouseUp, updateDragFromY]);

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
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/50 shrink-0">
        <p className="text-xs text-muted-foreground">
          Click an event to view · drag to move · drag bottom edge to resize
        </p>
        <button
          onClick={() => openNew()}
          className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-md border border-[var(--w-rule)] text-[oklch(0.55_0.12_85)] hover:bg-[var(--w-carbon-tint)] hover:text-[var(--w-carbon)] transition-colors"
        >
          <Plus className="h-3.5 w-3.5" /> Add event
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
                className="absolute right-2 text-xs font-medium text-muted-foreground/80 -translate-y-2"
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
                  onEventClick={(clicked) => {
                    // Ignore the click that fires at the end of a real drag.
                    if (hasDragged.current) return;
                    openDetail(clicked);
                  }}
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
          contacts={contacts}
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
        <div className="w-2 h-2 rounded-full bg-signal-critical shrink-0 -ml-1" />
        <div className="flex-1 h-px bg-signal-critical/70" />
      </div>
    </div>
  );
}
