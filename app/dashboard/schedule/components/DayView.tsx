"use client";

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { RsvpControls } from "@/components/calendar/rsvp-controls";
import { BTN_PRIMARY, BTN_SECONDARY } from "@/components/basil/page-hero";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import Link from "next/link";
import {
  X, Trash2, Video, Users, Save, Loader2, Plus, Pencil,
  MapPin, Clock, ExternalLink, Copy, Check, ChevronDown, ChevronUp,
  Send, Forward, Sparkles,
  Link as LinkIcon, CalendarSearch,
} from "lucide-react";
import { blockKind, KIND_STYLE, KIND_SUB, KIND_LABEL, KindSwatch, LIFT_SHADOW } from "./event-kind";

/** Inputs in the cream world: rounded-xl, ruled border, paper fill. */
const FIELD = "rounded-xl border-[var(--w-rule)] bg-[var(--w-paper)] text-[color:var(--w-ink)] placeholder:text-[color:var(--w-ink-soft)]";
/** A small mono label over a field or group. */
const EYEBROW = "basil-mono text-[11px] uppercase tracking-[0.12em] text-[color:var(--w-ink-soft)]";
/** Quiet icon button (edit / cancel / close) — 36px, cream hover. */
const ICON_BTN = "inline-flex h-9 w-9 items-center justify-center rounded-xl text-[color:var(--w-ink-soft)] transition-colors hover:bg-[var(--w-tray)] hover:text-[color:var(--w-ink)] disabled:opacity-50";

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
  organizerName?: string;
  organizerEmail?: string;
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

  // Same marks as the Today day ribbon: navy meeting, gold-hatch "just you",
  // cream + blue ring for an unanswered invitation, dashed ghost when declined.
  const kind = blockKind(event);
  const sub  = KIND_SUB[kind];
  const stateNote = kind === "invite" ? "needs reply" : kind === "declined" ? "declined" : "";

  return (
    <div
      className={`absolute left-1 right-3 rounded-xl px-2.5 py-1.5 select-none group overflow-hidden
        ${dragging ? "ring-2 ring-[#C8A96B] z-20" : "hover:-translate-y-0.5 hover:shadow-[0_16px_28px_-14px_rgba(16,33,63,.55)] z-10"}
        transition-[top,height,translate,box-shadow] cursor-pointer active:cursor-grabbing`}
      style={{
        ...KIND_STYLE[kind],
        top: `${top}px`,
        height: `${height}px`,
        minHeight: `${MIN_DURATION * PX_PER_MIN}px`,
        ...(dragging ? { boxShadow: LIFT_SHADOW, translate: "0 -2px" } : {}),
      }}
      // Button semantics: this was a bare <div onClick>, so every event on the
      // calendar was unreachable without a mouse. Drag stays mouse-only (a
      // separate concern), but OPENING an event must not require one.
      role="button"
      tabIndex={0}
      aria-label={`${event.summary}, ${minToTime(displayStart)} to ${minToTime(displayEnd)}${stateNote ? `, ${stateNote}` : ""}`}
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
      <div className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
        <Pencil className="h-3 w-3" style={{ color: sub }} />
      </div>

      <div className="flex items-start gap-1 overflow-hidden h-full pr-4">
        <div className="flex-1 min-w-0">
          <p
            className="text-[13px] font-semibold leading-tight truncate"
            style={{ textDecoration: kind === "declined" ? "line-through" : "none" }}
          >
            {event.summary}
          </p>
          {height >= 36 && (
            <p className="basil-mono text-[11px] leading-tight mt-0.5 truncate" style={{ color: sub }}>
              {minToTime(displayStart)} – {minToTime(displayEnd)}
              {stateNote && <span className="font-medium" style={{ color: kind === "invite" ? "#2F5FA8" : sub }}> · {stateNote}</span>}
            </p>
          )}
          {height >= 52 && event.attendees.length > 0 && (
            <p className="text-[12px] truncate flex items-center gap-1 mt-0.5" style={{ color: sub }}>
              <Users className="h-2.5 w-2.5 inline shrink-0" />
              {event.attendees.slice(0, 2).join(", ")}
              {event.attendees.length > 2 && ` +${event.attendees.length - 2}`}
            </p>
          )}
        </div>
        {event.hasVideo && height >= 36 && (
          <Video className="h-3 w-3 shrink-0 mt-0.5" style={{ color: sub }} />
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
  onResponded,
  deleting,
}: {
  event: DayEvent;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  /** Called after the user answers the invitation (or proposes a new time). */
  onResponded: () => void;
  deleting: boolean;
}) {
  const { startMin, endMin } = parseEventTimes(event);
  const dur = endMin - startMin;
  const [copied, setCopied] = useState(false);
  const [descExpanded, setDescExpanded] = useState(false);
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

  const kind = blockKind(event);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-[rgba(16,33,63,.35)] backdrop-blur-[2px]" onClick={onClose} />

      {/* Popover card */}
      <div className="basil-rise relative w-full max-w-sm max-h-[calc(100vh-2rem)] overflow-y-auto rounded-[20px] border border-[var(--w-rule)] bg-[var(--w-flimsy)] shadow-[0_30px_60px_-30px_rgba(16,33,63,.6)]" style={{ animationDuration: ".35s" }}>
        <div className="p-5 space-y-4">
          {/* Header */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5 pr-1">
              <span className="inline-flex items-center gap-1.5 text-[12px] text-[color:var(--w-ink-soft)]">
                <KindSwatch kind={kind} />
                {KIND_LABEL[kind]}
              </span>
              <h3
                className="basil-serif text-[26px] leading-[1.1] text-[#10213F]"
                style={{ textDecoration: kind === "declined" ? "line-through" : "none" }}
              >
                {event.summary}
              </h3>
            </div>
            <div className="flex items-center gap-0.5 shrink-0 -mr-1.5 -mt-1">
              {/* Organizer: Edit + Delete. Invitee: no edit/delete */}
              {isOrganizer && (
                <>
                  <button
                    onClick={onEdit}
                    className={ICON_BTN}
                    title="Edit event"
                    aria-label="Edit event"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    onClick={onDelete}
                    disabled={deleting}
                    className={`${ICON_BTN} hover:text-[color:var(--w-stamp)]`}
                    title="Cancel event"
                    aria-label="Cancel event"
                  >
                    {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  </button>
                </>
              )}
              <button
                onClick={onClose}
                className={ICON_BTN}
                title="Close"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
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
              className="rounded-xl border border-[var(--w-stamp)] bg-[var(--w-flimsy)] px-3 py-2 text-[13px] text-[color:var(--w-stamp)]"
            >
              {actionError}
            </p>
          )}

          {!isOrganizer && (
            <div className="space-y-1.5">
              <p className={EYEBROW}>Your response</p>
              {/* Shared with Today and Meetings: checks the server's answer
                  (the old buttons ignored it) and can propose a new time. */}
              <RsvpControls
                compact
                event={{
                  id: event.id, summary: event.summary, start: event.start, end: event.end,
                  isAllDay: event.isAllDay, myResponseStatus: event.myResponseStatus, isOrganizer,
                  organizerName: event.organizerName, organizerEmail: event.organizerEmail,
                }}
                onChanged={() => onResponded()}
              />
            </div>
          )}

          {/* Time */}
          <div className="flex items-center gap-2 text-[14px] text-[color:var(--w-ink)]">
            <Clock className="h-4 w-4 shrink-0 text-[color:var(--w-carbon)]" />
            <span>
              <span className="basil-mono">{minToTime(startMin)} – {minToTime(endMin)}</span>
              <span className="ml-1.5 text-[13px] text-[color:var(--w-ink-soft)]">({durationLabel(dur)})</span>
            </span>
          </div>

          {/* Location */}
          {event.location && !event.videoLink && (
            <div className="flex items-start gap-2 text-[14px] text-[color:var(--w-ink)]">
              <MapPin className="h-4 w-4 shrink-0 mt-0.5 text-[color:var(--w-carbon)]" />
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
                className={`${BTN_PRIMARY} flex-1`}
              >
                <Video className="h-4 w-4" />
                {videoLabel}
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
              <button
                onClick={copyLink}
                className={`${BTN_SECONDARY} w-11 px-0`}
                title="Copy link"
                aria-label="Copy meeting link"
              >
                {copied ? <Check className="h-4 w-4 text-[color:var(--w-filed)]" /> : <Copy className="h-4 w-4" />}
              </button>
            </div>
          )}

          {/* Attendees */}
          {event.attendees.length > 0 && (
            <div className="space-y-2">
              <p className={`${EYEBROW} flex items-center gap-1.5`}>
                <Users className="h-3 w-3" />
                {event.attendees.length} {event.attendees.length === 1 ? "attendee" : "attendees"}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {event.attendees.slice(0, 8).map((name, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-1.5 rounded-full border border-[var(--w-rule)] bg-[var(--w-paper)] py-0.5 pl-0.5 pr-2.5 text-[12px] font-medium text-[color:var(--w-ink)]"
                    title={name}
                  >
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#10213F] text-[9px] font-bold text-[#F6F1E7]">
                      {initials(name)}
                    </span>
                    <span className="truncate max-w-[120px]">{name}</span>
                  </div>
                ))}
                {event.attendees.length > 8 && (
                  <div className="flex items-center gap-1 px-2 py-0.5 text-[12px] text-[color:var(--w-ink-soft)]">
                    +{event.attendees.length - 8} more
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Description */}
          {descLines.length > 0 && (
            <div className="space-y-1">
              <p className="text-[13px] leading-relaxed text-[color:var(--w-ink-soft)]">
                {descExpanded ? event.description : shortDesc}
                {!descExpanded && hasMoreDesc && "…"}
              </p>
              {hasMoreDesc && (
                <button
                  onClick={() => setDescExpanded(!descExpanded)}
                  className="flex items-center gap-0.5 text-[13px] font-medium text-[color:var(--w-carbon)] transition-colors hover:underline"
                >
                  {descExpanded ? <><ChevronUp className="h-3 w-3" /> Show less</> : <><ChevronDown className="h-3 w-3" /> Show more</>}
                </button>
              )}
            </div>
          )}

          {/* ── Action bar ──────────────────────────────────────────────── */}
          <div className="border-t border-[var(--w-rule)] pt-3 space-y-1.5">

            {/* Create brief button */}
            <Link
              href={`/dashboard/meetings/${event.id}`}
              onClick={onClose}
              className={`${BTN_SECONDARY} w-full`}
            >
              <Sparkles className="h-4 w-4 text-[color:var(--w-carbon)]" />
              Create meeting brief
            </Link>

            {/* Reply section */}
            <div>
              <button
                onClick={() => { setReplyOpen((v) => !v); setForwardOpen(false); }}
                className="flex min-h-[40px] w-full items-center gap-2 rounded-xl px-1 text-[13px] font-medium text-[color:var(--w-ink)] transition-colors hover:text-[color:var(--w-carbon)]"
              >
                <Send className="h-3.5 w-3.5 text-[color:var(--w-carbon)]" />
                Reply to organiser
                {replyOpen ? <ChevronUp className="h-3.5 w-3.5 ml-auto" /> : <ChevronDown className="h-3.5 w-3.5 ml-auto" />}
              </button>
              {replyOpen && (
                <div className="mt-1 space-y-2">
                  <textarea
                    value={replyMessage}
                    onChange={(e) => setReplyMessage(e.target.value)}
                    autoFocus
                    rows={3}
                    placeholder="Type your message…"
                    className={`w-full resize-none border px-3 py-2 text-[14px] outline-none focus:border-[#C8A96B] ${FIELD}`}
                  />
                  <div className="flex items-center justify-between gap-2">
                    <label className="flex cursor-pointer items-center gap-1.5 text-[13px] text-[color:var(--w-ink-soft)]">
                      <input
                        type="checkbox"
                        checked={replyAll}
                        onChange={(e) => setReplyAll(e.target.checked)}
                        className="h-4 w-4 rounded accent-[#10213F]"
                      />
                      Reply all
                    </label>
                    <button
                      onClick={handleReply}
                      disabled={replySending || !replyMessage.trim()}
                      className={BTN_PRIMARY}
                    >
                      {replySent ? <><Check className="h-3.5 w-3.5" /> Sent</> : replySending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><Send className="h-3.5 w-3.5" /> Send</>}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Forward section */}
            <div>
              <button
                onClick={() => { setForwardOpen((v) => !v); setReplyOpen(false); }}
                className="flex min-h-[40px] w-full items-center gap-2 rounded-xl px-1 text-[13px] font-medium text-[color:var(--w-ink)] transition-colors hover:text-[color:var(--w-carbon)]"
              >
                <Forward className="h-3.5 w-3.5 text-[color:var(--w-carbon)]" />
                Forward invite
                {forwardOpen ? <ChevronUp className="h-3.5 w-3.5 ml-auto" /> : <ChevronDown className="h-3.5 w-3.5 ml-auto" />}
              </button>
              {forwardOpen && (
                <div className="mt-1 space-y-2">
                  <input
                    type="text"
                    value={forwardEmails}
                    onChange={(e) => setForwardEmails(e.target.value)}
                    autoFocus
                    placeholder="email@example.com, another@example.com"
                    className={`h-10 w-full border px-3 text-[14px] outline-none focus:border-[#C8A96B] ${FIELD}`}
                  />
                  <p className="text-[12px] text-[color:var(--w-ink-soft)]">Separate multiple addresses with commas</p>
                  <button
                    onClick={handleForward}
                    disabled={forwarding || !forwardEmails.trim()}
                    className={BTN_SECONDARY}
                  >
                    {forwardDone ? <><Check className="h-3.5 w-3.5 text-[color:var(--w-filed)]" /> Forwarded</> : forwarding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><Forward className="h-3.5 w-3.5" /> Forward</>}
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
        className={`h-11 text-[14px] ${FIELD}`}
        autoComplete="off"
      />
      {showDropdown && (
        <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-xl border border-[var(--w-rule)] bg-[var(--w-flimsy)] shadow-[0_16px_28px_-14px_rgba(16,33,63,.55)]">
          {matches.map((c, i) => (
            <button
              key={c.id}
              type="button"
              // Use mousedown so the selection happens before the input blurs.
              onMouseDown={(e) => { e.preventDefault(); selectMatch(c); }}
              onMouseEnter={() => setHighlight(i)}
              className={cn(
                "w-full flex items-center justify-between gap-2 px-3 py-2 text-[14px] text-left text-[color:var(--w-ink)] transition-colors",
                i === highlight ? "bg-[var(--w-tray)]" : "hover:bg-[var(--w-paper)]"
              )}
            >
              <span className="font-medium truncate">{c.name}</span>
              <span className="text-[12px] text-[color:var(--w-ink-soft)] truncate ml-2">{c.email}</span>
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
        className="flex min-h-[36px] items-center gap-1.5 text-[13px] font-medium text-[color:var(--w-carbon)] transition-colors hover:underline disabled:cursor-not-allowed disabled:text-[color:var(--w-ink-soft)] disabled:no-underline"
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
        <div className="rounded-xl border border-[var(--w-rule)] bg-[var(--w-paper)] p-2.5 space-y-2">
          {error && (
            <p className="text-[13px] text-[color:var(--w-manila)]">{error}</p>
          )}
          {slots.length === 0 && !error && (
            <p className="text-[13px] text-[color:var(--w-ink-soft)]">
              No mutual free slots in the next 7 days — try a different duration or check the attendees&apos; tz.
            </p>
          )}
          {slots.length > 0 && (
            <>
              <p className={EYEBROW}>
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
                      className="basil-lift inline-flex min-h-[36px] items-center gap-1.5 rounded-xl border border-[var(--w-rule)] bg-[var(--w-flimsy)] px-3 text-[13px] font-medium text-[color:var(--w-ink)]"
                    >
                      <Clock className="h-3.5 w-3.5 text-[color:var(--w-carbon)]" />
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
      <div className="absolute inset-0 bg-[rgba(16,33,63,.4)] backdrop-blur-sm" onClick={onClose} />
      <div className="basil-rise relative w-full max-w-md max-h-[calc(100vh-2rem)] overflow-y-auto rounded-[20px] border border-[var(--w-rule)] bg-[var(--w-paper)] p-6 space-y-4 shadow-[0_30px_60px_-30px_rgba(16,33,63,.6)]" style={{ animationDuration: ".35s" }}>
        <div className="flex items-center justify-between gap-3">
          <h3 className="basil-serif text-[30px] leading-none tracking-[-0.01em] text-[#10213F]">
            {isNew ? "New event" : "Edit event"}<span className="text-[#C8A96B]">.</span>
          </h3>
          <button onClick={onClose} className={`${ICON_BTN} -mr-2`} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ev-title" className={EYEBROW}>Title</Label>
          <Input
            id="ev-title"
            value={state.title}
            onChange={(e) => onChange({ title: e.target.value })}
            placeholder="Meeting title"
            className={`h-11 text-[15px] ${FIELD}`}
            autoFocus
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="ev-date" className={EYEBROW}>Date</Label>
            <Input
              id="ev-date"
              type="date"
              value={state.date}
              onChange={(e) => onChange({ date: e.target.value })}
              className={`basil-mono h-11 text-[14px] ${FIELD}`}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ev-start" className={EYEBROW}>Start time</Label>
            <Input
              id="ev-start"
              type="time"
              step={900}
              value={state.startTime}
              onChange={(e) => onChange({ startTime: e.target.value })}
              className={`basil-mono h-11 text-[14px] ${FIELD}`}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="ev-duration" className={EYEBROW}>Duration</Label>
            <select
              id="ev-duration"
              value={state.durationMin}
              onChange={(e) => onChange({ durationMin: Number(e.target.value) })}
              className={`h-11 w-full border px-3 text-[14px] ${FIELD}`}
            >
              {[15, 30, 45, 60, 90, 120, 180, 240].map((d) => (
                <option key={d} value={d}>
                  {d < 60 ? `${d} min` : `${d / 60}h${d % 60 ? ` ${d % 60}m` : ""}`}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label className={EYEBROW}>Ends at</Label>
            <div className="basil-mono flex h-11 items-center rounded-xl border border-[var(--w-rule)] bg-[var(--w-tray)] px-3 text-[14px] text-[color:var(--w-ink-soft)]">
              {endTime}
            </div>
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-2">
            <Label htmlFor="ev-attendees" className={EYEBROW}>Attendees</Label>
            <span className="text-[12px] text-[color:var(--w-ink-soft)]">Type to search your contacts</span>
          </div>
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
          <label className="flex min-h-[36px] flex-wrap items-center gap-2 cursor-pointer select-none text-[color:var(--w-ink)]">
            <input
              type="checkbox"
              checked={state.addVideoCall}
              onChange={(e) => onChange({ addVideoCall: e.target.checked })}
              className="h-4 w-4 rounded accent-[#10213F]"
            />
            <Video className="h-4 w-4 text-[color:var(--w-carbon)]" />
            <span className="text-[14px] font-medium">Add video call</span>
            {!state.videoLink.trim() && state.addVideoCall && (
              <span className="text-[13px] text-[color:var(--w-ink-soft)]">
                · Google Meet link will be generated
              </span>
            )}
          </label>

          {state.addVideoCall && (
            <div className="pl-6 space-y-1.5">
              <Label htmlFor="ev-videolink" className={EYEBROW}>
                Or paste a Zoom / Teams link
              </Label>
              <div className="relative">
                <LinkIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[color:var(--w-ink-soft)]" />
                <Input
                  id="ev-videolink"
                  value={state.videoLink}
                  onChange={(e) => onChange({ videoLink: e.target.value })}
                  placeholder="https://zoom.us/j/…  (leave blank for Meet)"
                  className={`h-11 pl-8 text-[14px] ${FIELD}`}
                />
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            onClick={onSave}
            disabled={saving || !state.title.trim()}
            className={`${BTN_PRIMARY} flex-1`}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {isNew ? "Create" : "Save changes"}
          </button>
          {!isNew && (
            <button
              type="button"
              onClick={onDelete}
              disabled={deleting}
              className={`${BTN_SECONDARY} text-[color:var(--w-stamp)] hover:border-[var(--w-stamp)]`}
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Delete
            </button>
          )}
          <button type="button" onClick={onClose} className={BTN_SECONDARY}>Cancel</button>
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
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-4 py-2 border-b border-[var(--w-rule)] shrink-0 sm:px-6">
        <p className="text-[12px] text-[color:var(--w-ink-soft)]">
          Click an event to view · drag to move · drag bottom edge to resize
        </p>
        <button
          onClick={() => openNew()}
          className="basil-lift inline-flex min-h-[36px] items-center gap-1.5 rounded-xl border border-[var(--w-rule-strong)] bg-[var(--w-flimsy)] px-3 text-[13px] font-medium text-[color:var(--w-ink)]"
        >
          <Plus className="h-3.5 w-3.5 text-[color:var(--w-carbon)]" /> Add event
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
          <div className="w-14 shrink-0 relative select-none" style={{ height: `${totalGridHeight}px` }}>
            {HOURS.map((h) => (
              <div
                key={h}
                className="basil-mono absolute right-2.5 text-[11px] text-[color:var(--w-ink-soft)] -translate-y-2"
                style={{ top: `${(h - GRID_START_H) * HOUR_HEIGHT}px` }}
              >
                {String(h).padStart(2, "0")}:00
              </div>
            ))}
          </div>

          {/* Event grid */}
          <div
            ref={gridRef}
            className="flex-1 relative cursor-crosshair mr-2 sm:mr-4"
            style={{ height: `${totalGridHeight}px` }}
            onClick={handleGridClick}
          >
            {/* Hour lines */}
            {HOURS.map((h) => (
              <div
                key={h}
                className="absolute left-0 right-0 border-t border-[var(--w-rule)]"
                style={{ top: `${(h - GRID_START_H) * HOUR_HEIGHT}px` }}
              />
            ))}
            {/* Half-hour lines */}
            {HOURS.map((h) => (
              <div
                key={`${h}h`}
                className="absolute left-0 right-0 border-t border-dashed border-[var(--w-tray)]"
                style={{ top: `${(h - GRID_START_H) * HOUR_HEIGHT + HOUR_HEIGHT / 2}px` }}
              />
            ))}

            {/* Current time indicator — only on today's grid */}
            <CurrentTimeIndicator date={date} />

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
          onResponded={onRefresh}
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
// The gold "now" line of the Today ribbon, laid across the grid: a 2px gold
// rule, a pulsing gold dot at the left edge, and the time in the hour gutter.
function CurrentTimeIndicator({ date }: { date: string }) {
  // Start null to avoid SSR/client hydration mismatch (React #418):
  // new Date() on server produces a different minute than on the client.
  const [now, setNow] = useState<{ min: number; day: string } | null>(null);

  useEffect(() => {
    // Set immediately on mount (client-only), then update every minute
    const update = () => {
      const n = new Date();
      const day = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
      setNow({ min: n.getHours() * 60 + n.getMinutes(), day });
    };
    update();
    const id = setInterval(update, 60_000);
    return () => clearInterval(id);
  }, []);

  if (now === null || now.day !== date) return null;
  const { min } = now;
  if (min < GRID_START_H * 60 || min > GRID_END_H * 60) return null;
  const top = (min - GRID_START_H * 60) * PX_PER_MIN;

  return (
    <div className="absolute left-0 right-0 z-30 pointer-events-none" style={{ top: `${top}px` }}>
      <span aria-hidden className="absolute left-0 right-0 -top-px h-[2px] rounded" style={{ background: "#C8A96B" }} />
      <span aria-hidden className="absolute -left-1.5 -top-1.5 h-3 w-3">
        <span className="basil-ping absolute inset-0 rounded-full" style={{ background: "#C8A96B" }} />
        <span className="absolute inset-0 rounded-full" style={{ background: "#C8A96B", boxShadow: "0 0 0 3px #FFFDF8" }} />
      </span>
      <span className="basil-mono absolute right-full top-0 mr-2.5 -translate-y-1/2 rounded bg-[var(--w-flimsy)] px-1 text-[11px] font-medium text-[color:var(--w-carbon)]">
        {minToTime(min)}
      </span>
    </div>
  );
}
