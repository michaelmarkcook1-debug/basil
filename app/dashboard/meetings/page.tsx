"use client";

/**
 * Calendar (was "Meeting prep"; restyled 2026-10-14: cream canvas, navy
 * chrome, live data graphics — see docs/design/visual-system.md).
 *
 * 2026-10-30: meetings can be cancelled (organiser) or declined and removed
 * (guest) with the right people told, and anything not yet accepted — an
 * invitation you haven't answered, a "maybe", or your own meeting nobody has
 * said yes to — is drawn differently from a settled meeting.
 *
 * Top to bottom: the page hero, the Upcoming / Past tabs, "Your next four
 * days" (meeting time per day, drawn only from the calendar events this page
 * already loads), the quick picker, then the meetings grouped by day.
 *
 */

import { preparationReasons, localDate } from "@/lib/today/executive";
import { RsvpControls, type Rsvp } from "@/components/calendar/rsvp-controls";
import { meetingState, statePill, type MeetingState, type PillTone } from "@/lib/calendar/meeting-state";
import { CancelMeetingDialog, type CancellableEvent, type CancelOutcome } from "@/components/calendar/cancel-meeting";
import { useEffect, useState, useMemo, useCallback } from "react";
import { DataState } from "@/components/ui/data-state";
import { NewEventDialog } from "@/app/dashboard/schedule/components/NewEventDialog";
import { useRouter } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHero, BTN_PRIMARY, BTN_SECONDARY } from "@/components/basil/page-hero";
import { CalendarCheck, Video, Users, ChevronDown, ChevronUp, Plus, Sparkles, Unplug, Search, Check, AlertTriangle, MapPin, Trash2 } from "lucide-react";
import { formatTime } from "@/lib/utils";
import { DEFAULT_TIMEZONE } from "@/lib/datetime";
import { localHours, hhmm } from "@/lib/today/visual-data";
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
  /** The API has always returned these; the local type simply never read them,
   *  so RSVP state was invisible on the one page about meetings. */
  myResponseStatus?: "accepted" | "declined" | "tentative" | "needsAction";
  isOrganizer?: boolean;
  organizerName?: string;
  organizerEmail?: string;
  /** Also already in the /api/calendar/upcoming response — read for the chips. */
  location?: string;
  videoLink?: string;
  /** Everyone else's answers (lib/google/calendar.ts guestTally). */
  guests?: { total: number; accepted: number; tentative: number; declined: number; waiting: number };
  recurring?: boolean;
}

/** The meeting has already ended — nothing left to answer. */
function isPast(end: string): boolean {
  const t = Date.parse(end);
  return Number.isFinite(t) && t < Date.now();
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

// ── Presentation helpers ─────────────────────────────────────────────────────

/** Times on this page are formatted by formatTime(), which reads UK time. The
 *  four-day graphic uses the same zone so a block sits where its card says. */
const TZ = DEFAULT_TIMEZONE;

const CARD = "rounded-[20px] border border-[var(--w-rule)] bg-[var(--w-flimsy)]";
const FIELD = "min-h-[44px] w-full rounded-xl border border-[var(--w-rule-strong)] bg-[var(--w-flimsy)] px-3.5 py-2 text-[14px] text-[color:var(--w-ink)] outline-none focus:border-[#C8A96B]";
const CHIP = "inline-flex min-h-[28px] items-center gap-1.5 rounded-full border border-[var(--w-rule)] bg-[var(--w-paper)] px-2.5 text-[12px] font-medium text-[color:var(--w-ink)]";

/**
 * RsvpControls is shared with Today and Schedule, so it is re-skinned here at
 * the call site: navy for the chosen answer, outlined cream for the others,
 * every control at least 44px tall.
 */
const RSVP_SKIN = [
  "[&_[data-slot=button]]:min-h-[44px] [&_[data-slot=button]]:rounded-xl [&_[data-slot=button]]:px-3.5 [&_[data-slot=button]]:text-[13px]",
  "[&_[data-variant=default]]:border-[#10213F] [&_[data-variant=default]]:bg-[#10213F] [&_[data-variant=default]]:text-[#F6F1E7]",
  "[&_[data-variant=outline]]:border-[var(--w-rule-strong)] [&_[data-variant=outline]]:bg-[var(--w-flimsy)] [&_[data-variant=outline]]:text-[color:var(--w-ink)] [&_[data-variant=outline]:hover]:border-[#C8A96B]",
  "[&_[data-variant=ghost]]:text-[color:var(--w-carbon)]",
].join(" ");

const PILL_TONE: Record<PillTone, string> = {
  invite: "border-[1.5px] border-[#2F5FA8] bg-[#2F5FA814] text-[#2F5FA8]",
  maybe: "border-[1.5px] border-dashed border-[#5E4A1F] bg-[#C8A96B26] text-[#5E4A1F]",
  waiting: "border-[1.5px] border-[#C8A96B] bg-[#C8A96B26] text-[#5E4A1F]",
  declined: "border border-[var(--w-rule)] bg-[var(--w-tray)] text-[#4B5568]",
};

/** The card's left edge carries the same signal as the four-day graphic. */
const CARD_EDGE: Partial<Record<MeetingState, string>> = {
  invite: "border-l-[5px] border-l-[#2F5FA8]",
  tentative: "border-l-[5px] border-l-[#5E4A1F]",
  awaiting: "border-l-[5px] border-l-[#C8A96B]",
};

function initials(name: string): string {
  const base = name.includes("@") ? name.split("@")[0].replace(/[._-]+/g, " ") : name;
  const parts = base.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Which call it is, read from the join link (or the location) the API returned. */
function videoLabel(e: CalEvent): string {
  const l = `${e.videoLink ?? ""} ${e.location ?? ""}`.toLowerCase();
  if (l.includes("zoom")) return "Zoom";
  if (l.includes("meet.google")) return "Google Meet";
  if (l.includes("teams.microsoft")) return "Teams";
  return "Video call";
}

/** A physical / named place, not a pasted join link. */
function placeOf(e: CalEvent): string | null {
  const loc = (e.location ?? "").trim();
  if (!loc || /^https?:\/\//i.test(loc) || /zoom\.us|meet\.google|teams\.microsoft/i.test(loc)) return null;
  return loc;
}

/** Initials circles, at most `max`, then "+n". Decorative: names are also given as text. */
function AvatarStack({ names, max = 4 }: { names: string[]; max?: number }) {
  const shown = names.slice(0, max);
  const extra = names.length - shown.length;
  return (
    <span className="flex shrink-0 items-center" aria-hidden>
      {shown.map((n, i) => (
        <span
          key={`${n}-${i}`}
          title={n}
          className={`flex h-8 w-8 items-center justify-center rounded-full bg-[#10213F] text-[11px] font-semibold text-[#F6F1E7] ring-2 ring-[var(--w-flimsy)] ${i > 0 ? "-ml-2" : ""}`}
        >
          {initials(n)}
        </span>
      ))}
      {extra > 0 && (
        <span className="basil-mono -ml-2 flex h-8 min-w-8 items-center justify-center rounded-full bg-[var(--w-tray)] px-1.5 text-[11px] font-semibold text-[color:var(--w-ink)] ring-2 ring-[var(--w-flimsy)]">
          +{extra}
        </span>
      )}
    </span>
  );
}

function PersonChip({ name }: { name: string }) {
  return (
    <span className="inline-flex min-h-[32px] items-center gap-2 rounded-full border border-[var(--w-rule)] bg-[var(--w-paper)] py-0.5 pl-0.5 pr-3 text-[13px] font-medium text-[color:var(--w-ink)]">
      <span aria-hidden className="flex h-7 w-7 items-center justify-center rounded-full bg-[#10213F] text-[10px] font-semibold text-[#F6F1E7]">{initials(name)}</span>
      {name}
    </span>
  );
}

// ── Your next four days (graphic) ────────────────────────────────────────────

const AXIS_START = 8;
const AXIS_END = 19;
const AXIS_SPAN = AXIS_END - AXIS_START;
const LANE_H = 44;
const LANE_GAP = 4;
const TRACK_PAD = 4;
const at = (h: number) => ((h - AXIS_START) / AXIS_SPAN) * 100;

type MarkKind = MeetingState;

interface DayMark {
  id: string;
  kind: MarkKind;
  start: number;
  end: number;
  lane: number;
  title: string;
  time: string;
  who: string;
  href?: string;
}

interface DayRow {
  key: string;
  label: string;
  sub: string;
  marks: DayMark[];
  lanes: number;
  /** Minutes of meetings you are going to (declined excluded), whole length. */
  minutes: number;
  count: number;
  declined: number;
  /** Meetings that fall wholly outside 08:00–19:00, so are not drawn. */
  outside: number;
  isToday: boolean;
}

const MARK_STYLE: Record<MarkKind, React.CSSProperties> = {
  meeting: { background: "#10213F", color: "#F6F1E7", border: "1px solid #10213F" },
  invite: { background: "#FFFDF8", color: "#2F5FA8", border: "2px solid #2F5FA8" },
  tentative: { background: "#FBF4E4", color: "#5E4A1F", border: "2px dashed #5E4A1F" },
  awaiting: { background: "repeating-linear-gradient(135deg, #10213F 0 7px, #2A3E66 7px 14px)", color: "#F6F1E7", border: "2px solid #C8A96B" },
  declined: { background: "#F6F1E7", color: "#4B5568", border: "1.5px dashed #8A8F99" },
};

const MARK_STATE: Record<MarkKind, string> = {
  meeting: "",
  invite: ", not answered yet",
  tentative: ", you said maybe",
  awaiting: ", no guest has accepted yet",
  declined: ", declined",
};

function fmtMinutes(m: number): string {
  if (m <= 0) return "Clear";
  const h = Math.floor(m / 60), r = Math.round(m % 60);
  if (h === 0) return `${r}m`;
  return r ? `${h}h ${r}m` : `${h}h`;
}

/** The four calendar days from today (in TZ), each with its meetings laid into lanes. */
function buildFourDays(events: CalEvent[], now: Date): DayRow[] {
  const todayKey = localDate(now, TZ);
  const [y, m, d] = todayKey.split("-").map(Number);
  const rows: DayRow[] = Array.from({ length: 4 }, (_, i) => {
    const noon = new Date(Date.UTC(y, m - 1, d + i, 12));
    const key = noon.toISOString().slice(0, 10);
    const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long" }).format(noon);
    const sub = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(noon);
    return {
      key, sub,
      label: i === 0 ? "Today" : i === 1 ? "Tomorrow" : weekday,
      marks: [], lanes: 1, minutes: 0, count: 0, declined: 0, outside: 0, isToday: i === 0,
    };
  });
  const byKey = new Map(rows.map((r) => [r.key, r]));

  for (const e of events) {
    if (e.isAllDay) continue;
    const row = byKey.get(localDate(new Date(e.start), TZ));
    if (!row) continue;
    const s = localHours(e.start, TZ);
    const sameDay = localDate(new Date(e.end), TZ) === row.key;
    const t = sameDay ? localHours(e.end, TZ) : 24;
    if (!(t > s)) continue;
    const kind = meetingState(e);
    if (kind === "declined") row.declined++;
    else { row.count++; row.minutes += (t - s) * 60; }
    const cs = Math.max(s, AXIS_START), ct = Math.min(t, AXIS_END);
    if (ct <= cs) { row.outside++; continue; }
    const names = e.attendees ?? [];
    row.marks.push({
      id: e.id,
      kind,
      start: cs,
      end: ct,
      lane: 0,
      title: e.summary || "Untitled",
      time: `${formatTime(e.start)} – ${formatTime(e.end)}`,
      who: names.length === 0 ? "Just you" : names.length <= 2 ? `With ${names.join(" and ")}` : `With ${names[0]} and ${names.length - 1} others`,
      href: kind !== "declined" && isPrepWorthy(e) ? `/dashboard/meetings/${e.id}` : undefined,
    });
  }

  // Overlaps go into lanes (max 3) so a double-booking reads as one, not as a hidden block.
  for (const row of rows) {
    row.marks.sort((a, b) => a.start - b.start || b.end - a.end);
    const laneEnds: number[] = [];
    for (const mk of row.marks) {
      let lane = laneEnds.findIndex((end) => end <= mk.start + 1e-6);
      if (lane === -1) lane = laneEnds.length < 3 ? laneEnds.length : laneEnds.length - 1;
      laneEnds[lane] = Math.max(laneEnds[lane] ?? 0, mk.end);
      mk.lane = lane;
    }
    row.lanes = Math.max(1, laneEnds.length);
  }
  return rows;
}

function NextFourDays({ events, onCancel }: { events: CalEvent[]; onCancel: (e: CalEvent) => void }) {
  const { rows, nowH } = useMemo(() => {
    const now = new Date();
    return { rows: buildFourDays(events, now), nowH: localHours(now.toISOString(), TZ) };
  }, [events]);
  const all = useMemo(() => rows.flatMap((r) => r.marks.map((mk) => ({ mk, row: r }))), [rows]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const fallback = all.find(({ mk, row }) => mk.kind !== "declined" && (!row.isToday || mk.end > nowH)) ?? all[0];
  const focus = all.find(({ mk }) => mk.id === focusId) ?? fallback;
  const nowIn = nowH >= AXIS_START && nowH <= AXIS_END;
  const ticks = Array.from({ length: AXIS_SPAN + 1 }, (_, i) => AXIS_START + i);

  return (
    <section
      aria-labelledby="four-days-h"
      className="basil-rise flex flex-col gap-4 rounded-[24px] border border-[var(--w-rule)] bg-[var(--w-flimsy)] p-5 sm:p-6"
      style={{ animationDelay: "160ms" }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2.5">
        <h2 id="four-days-h" className="basil-serif text-[30px] leading-tight text-[#10213F]">Your next four days</h2>
        <span className="flex flex-wrap gap-4 text-[12px] text-[color:var(--w-ink-soft)]">
          <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-2.5 w-3.5 rounded-[3px] bg-[#10213F]" />Meeting</span>
          <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-2.5 w-3.5 rounded-[3px] border-2 border-[#2F5FA8] bg-[var(--w-flimsy)]" />Not answered</span>
          <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-2.5 w-3.5 rounded-[3px] border-2 border-dashed border-[#5E4A1F] bg-[#FBF4E4]" />Maybe</span>
          <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-2.5 w-3.5 rounded-[3px] border-2 border-[#C8A96B]" style={{ background: MARK_STYLE.awaiting.background }} />No one accepted yet</span>
          <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-2.5 w-3.5 rounded-[3px] border-[1.5px] border-dashed border-[#8A8F99] bg-[var(--w-paper)]" />Declined</span>
        </span>
      </div>

      <div className="overflow-x-auto">
        <div className="flex min-w-[620px] flex-col gap-2.5">
          {/* Hour axis, aligned with the tracks */}
          <div className="grid grid-cols-[112px_minmax(0,1fr)_96px] gap-3">
            <span />
            <div className="relative h-4">
              {ticks.filter((h) => h % 2 === 0).map((h) => (
                <span key={h} className="basil-mono absolute top-0 -translate-x-1/2 text-[11px] text-[color:var(--w-ink-soft)]" style={{ left: `${at(h)}%` }}>
                  {String(h).padStart(2, "0")}:00
                </span>
              ))}
            </div>
            <span />
          </div>

          {rows.map((row, ri) => {
            const height = TRACK_PAD * 2 + row.lanes * LANE_H + (row.lanes - 1) * LANE_GAP;
            return (
              <div key={row.key} className="grid grid-cols-[112px_minmax(0,1fr)_96px] items-center gap-3">
                <div className="flex flex-col">
                  <span className="text-[14px] font-semibold text-[color:var(--w-ink)]">{row.label}</span>
                  <span className="basil-mono text-[11px] text-[color:var(--w-ink-soft)]">{row.sub}</span>
                </div>

                <div className="relative rounded-[12px] bg-[var(--w-tray)]" style={{ height }}>
                  {ticks.map((h) => (
                    <span key={h} aria-hidden className="absolute bottom-0 top-0 w-px bg-[var(--w-rule)]" style={{ left: `${at(h)}%` }} />
                  ))}
                  {row.marks.length === 0 && (
                    <span className="absolute inset-0 flex items-center justify-center text-[12px] text-[color:var(--w-ink-soft)]">
                      Nothing booked between 08:00 and 19:00
                    </span>
                  )}
                  {row.marks.map((mk, mi) => {
                    const on = focus?.mk.id === mk.id;
                    return (
                      <button
                        key={mk.id}
                        type="button"
                        onMouseEnter={() => setFocusId(mk.id)}
                        onFocus={() => setFocusId(mk.id)}
                        onClick={() => setFocusId(mk.id)}
                        aria-label={`${mk.title}, ${row.label} ${mk.time}${MARK_STATE[mk.kind]}`}
                        className="basil-grow absolute flex items-center overflow-hidden rounded-[10px] px-2 text-left transition-[translate,box-shadow] duration-200"
                        style={{
                          ...MARK_STYLE[mk.kind],
                          left: `${at(mk.start)}%`,
                          width: `${Math.max(0.9, at(mk.end) - at(mk.start))}%`,
                          top: TRACK_PAD + mk.lane * (LANE_H + LANE_GAP),
                          height: LANE_H,
                          animationDelay: `${240 + ri * 80 + mi * 50}ms`,
                          translate: on ? "0 -3px" : "0 0",
                          boxShadow: on ? "0 14px 24px -14px rgba(16,33,63,.6)" : "none",
                        }}
                      >
                        <span className="truncate text-[12px] font-semibold" style={{ textDecoration: mk.kind === "declined" ? "line-through" : "none" }}>
                          {mk.title}
                        </span>
                      </button>
                    );
                  })}
                  {row.isToday && nowIn && (
                    <span aria-hidden className="absolute -bottom-1 -top-1 w-[2px] rounded bg-[#C8A96B]" style={{ left: `${at(nowH)}%` }} />
                  )}
                </div>

                <div className="flex flex-col items-end text-right">
                  <span className="basil-mono text-[14px] font-medium text-[color:var(--w-ink)]">{fmtMinutes(row.minutes)}</span>
                  <span className="text-[12px] text-[color:var(--w-ink-soft)]">
                    {row.count} meeting{row.count === 1 ? "" : "s"}
                  </span>
                  {row.declined > 0 && (
                    <span className="text-[12px] text-[color:var(--w-ink-soft)]">{row.declined} declined</span>
                  )}
                  {row.outside > 0 && (
                    <span className="text-[12px] text-[color:var(--w-ink-soft)]">{row.outside} outside 08–19</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {focus ? (
        <div aria-live="polite" className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-2xl border border-[var(--w-rule)] bg-[var(--w-paper)] px-[18px] py-4">
          <span className="basil-mono min-w-[150px] text-[13px] text-[color:var(--w-ink-soft)]">
            {focus.row.label} · {focus.mk.time}
          </span>
          <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-1">
            <span className="basil-serif text-[24px] leading-tight text-[#10213F]">{focus.mk.title}</span>
            <span className="text-[14px] text-[color:var(--w-ink-soft)]">
              {focus.mk.kind === "declined"
                ? "You declined this one."
                : focus.mk.kind === "invite"
                  ? `You have not answered this invitation yet. ${focus.mk.who}.`
                  : focus.mk.kind === "tentative"
                    ? `You said maybe. ${focus.mk.who}.`
                    : focus.mk.kind === "awaiting"
                      ? `${focus.mk.who}. No one has accepted yet.`
                      : `${focus.mk.who}.`}
            </span>
          </div>
          {focus.mk.href && (
            <Link href={focus.mk.href} className={`basil-lift ${BTN_SECONDARY} text-[#10213F] no-underline`}>
              Open prep
            </Link>
          )}
          {(() => {
            const ev = events.find((e) => e.id === focus.mk.id);
            if (!ev || focus.mk.kind === "declined" || isPast(ev.end)) return null;
            return (
              <button type="button" onClick={() => onCancel(ev)} className={`${BTN_SECONDARY} hover:border-[var(--w-stamp)] hover:text-[color:var(--w-stamp)]`}>
                <Trash2 className="h-4 w-4" aria-hidden /> {ev.isOrganizer ? "Cancel" : "Decline and remove"}
              </button>
            );
          })()}
        </div>
      ) : (
        <p className="text-[15px] text-[color:var(--w-ink-soft)]">
          Nothing booked in the next four days.
        </p>
      )}
      <p className="sr-only">Times are UK time; the bars run from {hhmm(AXIS_START)} to {hhmm(AXIS_END)}.</p>
    </section>
  );
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
    <div className="basil-rise flex flex-col gap-3" style={{ animationDelay: "220ms" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`${BTN_SECONDARY} self-start`}
      >
        <Search className="h-4 w-4" aria-hidden />
        Prep a specific meeting
        {open ? <ChevronUp className="h-4 w-4" aria-hidden /> : <ChevronDown className="h-4 w-4" aria-hidden />}
      </button>

      {open && (
        <div className={`${CARD} flex flex-col gap-3 p-4 sm:p-5`}>
          <p className="text-[13px] text-[color:var(--w-ink-soft)]">
            Select any upcoming calendar event to generate a prep cheatsheet.
          </p>

          {/* Search */}
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by title, attendee, or day…"
            aria-label="Search upcoming meetings"
            autoFocus
            className={FIELD}
          />

          {/* Event list */}
          <div className="max-h-80 space-y-1 overflow-y-auto pr-1">
            {filtered.length === 0 ? (
              <p className="py-3 text-center text-[13px] text-[color:var(--w-ink-soft)]">No meetings match.</p>
            ) : (
              filtered.map((event) => (
                <button
                  type="button"
                  key={event.id}
                  onClick={() => router.push(`/dashboard/meetings/${event.id}`)}
                  className="flex min-h-[52px] w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left text-[14px] text-[color:var(--w-ink)] transition-colors hover:bg-[var(--w-tray)]"
                >
                  {/* Time block */}
                  <span className="flex min-w-[64px] shrink-0 flex-col items-center justify-center rounded-xl bg-[var(--w-tray)] px-2 py-1.5 text-center">
                    <span className="basil-mono text-[13px] font-medium text-[color:var(--w-ink)]">{formatTime(event.start)}</span>
                    {event.dateLabel && (
                      <span className="text-[11px] leading-tight text-[color:var(--w-ink-soft)]">
                        {event.dateLabel === "Today" || event.dateLabel === "Tomorrow"
                          ? event.dateLabel
                          : event.dateLabel.split(",")[0]}
                      </span>
                    )}
                  </span>

                  {/* Title + attendees */}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{event.summary}</span>
                    {event.attendees && event.attendees.length > 0 && (
                      <span className="truncate text-[12px] text-[color:var(--w-ink-soft)]">
                        {event.attendees.slice(0, 3).join(", ")}
                        {event.attendees.length > 3 ? ` +${event.attendees.length - 3}` : ""}
                      </span>
                    )}
                  </span>

                  {/* Indicators — readiness first, because it is the only one
                      that asks something of the reader. */}
                  <span className="flex shrink-0 items-center gap-1.5">
                    {(() => {
                      const reasons = preparationReasons({
                        myResponseStatus: event.myResponseStatus ?? "accepted",
                        attendeeCount: event.attendeeCount ?? 0,
                        hasVideo: !!event.hasVideo,
                        isOrganizer: !!event.isOrganizer,
                      } as Parameters<typeof preparationReasons>[0]);
                      return reasons.length > 0 ? (
                        <span
                          className="inline-flex items-center gap-1 rounded-full border border-[var(--w-manila)] bg-[var(--w-flimsy)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--w-manila)]"
                          title={`Needs preparation: ${reasons.join(" · ")}`}
                        >
                          <AlertTriangle className="h-3 w-3" aria-hidden />
                          {reasons[0]}
                        </span>
                      ) : null;
                    })()}
                    {event.hasVideo && <Video className="h-4 w-4 text-[color:var(--w-ink-soft)]" aria-hidden />}
                    <Sparkles className="h-4 w-4 text-[color:var(--w-carbon)]" aria-hidden />
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
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

  const label = "mb-1.5 block text-[13px] font-medium text-[color:var(--w-ink)]";

  return (
    <div className="mt-3 flex flex-col gap-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`${BTN_SECONDARY} self-start`}
      >
        <Plus className="h-4 w-4" aria-hidden />
        Manual meeting note
        {open ? <ChevronUp className="h-4 w-4" aria-hidden /> : <ChevronDown className="h-4 w-4" aria-hidden />}
      </button>

      {open && (
        <div className={`${CARD} p-5`}>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="manual-title" className={label}>Meeting title</label>
              <input
                id="manual-title"
                required
                type="text"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="e.g. Q2 review with Acme"
                className={FIELD}
              />
            </div>
            <div>
              <label htmlFor="manual-datetime" className={label}>Date &amp; time</label>
              <input
                id="manual-datetime"
                required
                type="datetime-local"
                value={form.datetime}
                onChange={(e) => setForm((f) => ({ ...f, datetime: e.target.value }))}
                className={FIELD}
              />
            </div>
            <div>
              <label htmlFor="manual-attendees" className={label}>
                Attendees{" "}
                <span className="font-normal text-[color:var(--w-ink-soft)]">(comma-separated)</span>
              </label>
              <input
                id="manual-attendees"
                type="text"
                value={form.attendees}
                onChange={(e) => setForm((f) => ({ ...f, attendees: e.target.value }))}
                placeholder="e.g. Alice, Bob, carol@example.com"
                className={FIELD}
              />
            </div>
            <div>
              <label htmlFor="manual-context" className={label}>Context / notes</label>
              <textarea
                id="manual-context"
                value={form.context}
                onChange={(e) => setForm((f) => ({ ...f, context: e.target.value }))}
                placeholder="Background, open questions, relevant history…"
                rows={3}
                className={`${FIELD} resize-none`}
              />
            </div>
            <div>
              <label htmlFor="manual-outcome" className={label}>Desired outcome</label>
              <input
                id="manual-outcome"
                type="text"
                value={form.outcome}
                onChange={(e) => setForm((f) => ({ ...f, outcome: e.target.value }))}
                placeholder="e.g. Agree on Q3 budget"
                className={FIELD}
              />
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <button type="submit" disabled={saving} className={BTN_PRIMARY}>
                {saving ? "Saving…" : "Save note"}
              </button>
              <button type="button" onClick={() => setOpen(false)} className={BTN_SECONDARY}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function ManualPrepList({ preps }: { preps: ManualPrep[] }) {
  if (preps.length === 0) return null;
  return (
    <div className="mt-5 flex flex-col gap-3">
      <h3 className="basil-serif text-[24px] text-[#10213F]">Saved notes</h3>
      {preps.map((prep, i) => (
        <article key={prep.id} className={`basil-rise ${CARD} p-5`} style={{ animationDelay: `${i * 70}ms` }}>
          <div className="flex items-start gap-3">
            <CalendarCheck className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--w-carbon)]" aria-hidden />
            <div className="flex min-w-0 flex-col gap-1">
              <p className="text-[15px] font-semibold text-[color:var(--w-ink)]">{prep.title}</p>
              {prep.datetime && (
                <p className="basil-mono text-[12px] text-[color:var(--w-ink-soft)]">
                  {new Date(prep.datetime).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </p>
              )}
              {prep.attendees && (
                <p className="truncate text-[13px] text-[color:var(--w-ink-soft)]">
                  <Users className="mr-1 inline h-3.5 w-3.5" aria-hidden />
                  {prep.attendees}
                </p>
              )}
              {prep.outcome && (
                <p className="basil-serif text-[18px] italic text-[color:var(--w-carbon)]">
                  Goal: {prep.outcome}
                </p>
              )}
            </div>
          </div>
        </article>
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
  // Position of each event in the list — drives the staggered load reveal.
  const order = new Map(events.map((e, i) => [e.id, i]));

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
  const [cancelling, setCancelling] = useState<CalEvent | null>(null);

  const flash = (text: string) => { setToast(text); setTimeout(() => setToast(null), 6000); };

  /** An answer given on a card redraws the graphic and the flag straight away. */
  const onAnswered = (id: string, status: Rsvp) =>
    setEvents((prev) => prev.map((e) => (e.id === id ? { ...e, myResponseStatus: status } : e)));

  const onCancelled = (out: CancelOutcome, ev: CancellableEvent) => {
    setEvents((prev) => prev.filter((e) => e.id !== ev.id));
    const told = out.told.length === 0 ? "" : out.told.length === 1 ? ` ${out.told[0]} has been told.` : ` ${out.told.length} guests have been told.`;
    const head = out.role === "organiser" ? `Cancelled "${ev.summary}".` : `Declined "${ev.summary}" and removed it.`;
    const noteFail = out.role === "organiser" && out.told.length > 0 && !out.noteSent && out.noteGiven ? " Your note did not send — Google's cancellation still went." : "";
    flash(head + told + noteFail);
  };

  return (
    <div className="wire basil-dots relative min-h-full overflow-hidden">
      <span aria-hidden className="pointer-events-none absolute -right-40 -top-56 h-[560px] w-[760px] rounded-full" style={{ background: "radial-gradient(closest-side, rgba(212,185,120,.32), transparent 72%)" }} />
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
      <CancelMeetingDialog
        event={cancelling}
        open={cancelling !== null}
        onOpenChange={(v) => { if (!v) setCancelling(null); }}
        onDone={onCancelled}
      />
      {toast && (
        <div role="status" className="fixed bottom-5 right-5 z-50 flex max-w-sm items-start gap-2 rounded-2xl bg-[#10213F] px-4 py-3 text-[14px] text-[#F6F1E7] shadow-lg">
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-[#D4B978]" aria-hidden />
          <span>{toast}</span>
        </div>
      )}

      <div className="relative mx-auto flex w-full max-w-[78rem] flex-col gap-7 px-4 py-6 sm:px-8 sm:py-10">
        <PageHero
          eyebrow={connected ? `Meetings & prep · ${rangeLabel}` : "Meetings & prep"}
          title="Calendar"
          subtitle={activeTab === "upcoming"
            ? connected
              ? `Showing ${rangeLabel}. Open a meeting to prep for it, answer an invite, or cancel.`
              : "Connect Google Calendar to see upcoming meetings."
            : "Recaps of meetings Basil has analysed."}
          actions={
            <button type="button" className={BTN_PRIMARY} onClick={() => setNewEventOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden /> New event
            </button>
          }
        />

        {/* ── Tab strip ─────────────────────────────────────────────────────── */}
        <div className="basil-rise flex flex-wrap items-center gap-2" style={{ animationDelay: "80ms" }}>
          {([
            { id: "upcoming", label: "Upcoming", count: events.length },
            { id: "past",     label: "Past intelligence",  count: pastMeetings.length },
          ] as const).map((tab) => {
            const active = activeTab === tab.id;
            return (
              <button
                type="button"
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                aria-pressed={active}
                className={`inline-flex min-h-[44px] items-center gap-2 rounded-full border px-4 text-[14px] font-medium transition-colors ${
                  active
                    ? "border-[#10213F] bg-[#10213F] text-[#F6F1E7]"
                    : "border-[var(--w-rule-strong)] bg-[var(--w-flimsy)] text-[color:var(--w-ink)] hover:border-[#C8A96B]"
                }`}
              >
                {tab.label}
                {tab.count > 0 && (
                  <span className={`basil-mono inline-flex h-6 min-w-[24px] items-center justify-center rounded-full px-1.5 text-[12px] font-semibold ${
                    active
                      ? "bg-[#C8A96B] text-[#10213F]"
                      : "bg-[var(--w-tray)] text-[color:var(--w-ink)]"
                  }`}>
                    {tab.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* ── PAST INTELLIGENCE TAB ───────────────────────────────────────── */}
        {activeTab === "past" && (
          <div>
            {pastLoading ? (
              <div className="flex flex-col gap-4">
                {[0, 1, 2].map((i) => (
                  <div key={i} className={`${CARD} space-y-2 p-5`}>
                    <Skeleton className="mb-2 h-5 w-2/3" />
                    <Skeleton className="h-3 w-full" />
                    <Skeleton className="mt-1 h-3 w-3/4" />
                  </div>
                ))}
              </div>
            ) : pastMeetings.length === 0 ? (
              <div className={`basil-rise ${CARD} flex flex-col items-center gap-2 px-5 py-12 text-center`}>
                <Video className="h-9 w-9 text-[color:var(--w-ink-soft)]" aria-hidden />
                <p className="basil-serif text-[24px] text-[#10213F]">No past meeting intelligence yet.</p>
                <p className="text-[14px] text-[color:var(--w-ink-soft)]">
                  Basil surfaces recaps automatically when Zoom emails arrive.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {pastMeetings.map((mem, i) => {
                  const { title, summary, date, attendees } = parseMeetingMemory(mem.content);
                  const meetingDate = date ? formatMeetingDate(date) : "";
                  const ingested = formatIngested(mem.createdAt);
                  return (
                    <article
                      key={mem.id}
                      className={`basil-rise ${CARD} flex flex-col gap-3 p-5 sm:p-6`}
                      style={{ animationDelay: `${120 + Math.min(i, 10) * 70}ms` }}
                    >
                      {/* Title + date */}
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                        <h3 className="basil-serif text-[24px] leading-tight text-[#10213F]">{title}</h3>
                        {(meetingDate || ingested) && (
                          <span className="basil-mono text-[12px] text-[color:var(--w-ink-soft)]">
                            {meetingDate}
                            {meetingDate && ingested ? " · " : ""}
                            {ingested && `captured ${ingested}`}
                          </span>
                        )}
                      </div>

                      {/* Attendees */}
                      {attendees.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5">
                          {attendees.slice(0, 6).map((name, j) => (
                            <PersonChip key={j} name={name} />
                          ))}
                          {attendees.length > 6 && (
                            <span className="text-[13px] text-[color:var(--w-ink-soft)]">
                              +{attendees.length - 6} more
                            </span>
                          )}
                        </div>
                      )}

                      {/* Summary */}
                      {summary && (
                        <p className="basil-serif line-clamp-4 text-[20px] leading-snug text-[color:var(--w-ink)]">
                          {summary}
                        </p>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── UPCOMING MEETINGS TAB ───────────────────────────────────────── */}
        {activeTab === "upcoming" && (loading ? (
          <div className="flex flex-col gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className={`${CARD} p-5`}>
                <div className="flex gap-4">
                  <Skeleton className="h-14 w-20 rounded-2xl" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-1/2" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          /* ── Load failed (distinct from "not connected") ─────────────────────── */
          <DataState fill error={error} onRetry={load} />
        ) : !connected ? (
          /* ── Not connected ───────────────────────────────────────────────────── */
          <div className="flex flex-col gap-6">
            <div className={`basil-rise ${CARD} flex flex-col items-center gap-2 px-5 py-10 text-center`}>
              <Unplug className="h-9 w-9 text-[color:var(--w-ink-soft)]" aria-hidden />
              <p className="basil-serif text-[26px] text-[#10213F]">Google Calendar is not connected.</p>
              <p className="text-[14px] text-[color:var(--w-ink-soft)]">
                Connect Google Workspace to see upcoming meetings and generate cheatsheets.
              </p>
              <Link href="/dashboard/settings?tab=google" className={`${BTN_PRIMARY} mt-3 no-underline`}>
                Connect Google →
              </Link>
            </div>

            <div>
              <p className="text-[14px] text-[color:var(--w-ink-soft)]">
                Or save a manual meeting note:
              </p>
              <ManualPrepForm onSaved={handleManualSaved} />
              <ManualPrepList preps={manualPreps} />
            </div>
          </div>
        ) : (
          /* ── Connected ───────────────────────────────────────────────────────── */
          <div className="flex flex-col gap-7">

            {/* The shape of the next four days — drawn from the events above */}
            {events.length > 0 && <NextFourDays events={events} onCancel={setCancelling} />}

            {/* Quick picker — jump to any meeting's prep page directly */}
            {events.length > 0 && <CalendarMeetingPicker events={events} />}

            {/* Grouped meeting list */}
            {events.length === 0 ? (
              <div className={`basil-rise ${CARD} px-5 py-12 text-center`}>
                <p className="basil-serif text-[24px] text-[#10213F]">No upcoming meetings in the next 14 days.</p>
              </div>
            ) : (
              dayOrder.map((dayLabel) => (
                <section key={dayLabel} aria-label={dayLabel} className="flex flex-col gap-3.5">
                  <div
                    className="basil-rise flex items-baseline gap-3 px-1"
                    style={{ animationDelay: `${240 + Math.min(order.get(grouped[dayLabel][0].id) ?? 0, 12) * 70}ms` }}
                  >
                    <h2 className="basil-serif text-[26px] leading-tight text-[#10213F]">
                      {dayLabel}
                    </h2>
                    <span aria-hidden className="h-px flex-1 self-center bg-[var(--w-rule)]" />
                    <span className="basil-mono text-[12px] text-[color:var(--w-ink-soft)]">
                      {grouped[dayLabel].length} meeting
                      {grouped[dayLabel].length !== 1 ? "s" : ""}
                    </span>
                  </div>

                  {grouped[dayLabel].map((event) => {
                    // Solo blocks (Focus time, Lunch, Decompress) still SHOW —
                    // they're your real day — but they don't pretend to be
                    // preppable: no Prep CTA, and no link to a cheatsheet that
                    // would have nothing to say.
                    const preppable = isPrepWorthy(event);
                    const names = event.attendees ?? [];
                    const place = placeOf(event);
                    const state = meetingState(event);
                    const pill = statePill(event);
                    const body = (
                      <>
                        {/* Time block */}
                        <span className="flex min-w-[84px] shrink-0 flex-col items-center justify-center gap-0.5 rounded-2xl bg-[var(--w-tray)] px-3 py-3 text-center">
                          <span className="basil-mono text-[16px] font-medium text-[color:var(--w-ink)]">
                            {formatTime(event.start)}
                          </span>
                          <span className="basil-mono text-[12px] text-[color:var(--w-ink-soft)]">
                            {formatTime(event.end)}
                          </span>
                        </span>

                        {/* Title + meta */}
                        <div className="flex min-w-0 flex-[1_1_220px] flex-col gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-[16px] font-semibold leading-snug text-[color:var(--w-ink)]" style={{ textDecoration: state === "declined" ? "line-through" : "none" }}>{event.summary}</h3>
                            {pill && (
                              <span className={`inline-flex min-h-[24px] items-center rounded-full px-2.5 text-[12px] font-semibold ${PILL_TONE[pill.tone]}`}>
                                {pill.text}
                              </span>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-2.5">
                            {names.length > 0 && (
                              <span className="flex min-w-0 items-center gap-2">
                                <AvatarStack names={names} />
                                <span className="truncate text-[13px] text-[color:var(--w-ink-soft)]">
                                  {names.slice(0, 4).join(", ")}
                                  {names.length > 4 ? ` +${names.length - 4}` : ""}
                                </span>
                              </span>
                            )}
                            {event.hasVideo && (
                              <span className={CHIP}>
                                <Video className="h-3.5 w-3.5" aria-hidden /> {videoLabel(event)}
                              </span>
                            )}
                            {place && (
                              <span className={`${CHIP} max-w-[240px]`}>
                                <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden />
                                <span className="truncate">{place}</span>
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Prep CTA — only when there's someone to prep for */}
                        {preppable && (
                          <span className={`${BTN_PRIMARY} shrink-0`}>
                            <Sparkles className="h-4 w-4 text-[#D4B978]" aria-hidden />
                            Prep
                          </span>
                        )}
                      </>
                    );
                    // Answer the invitation right here. Kept OUTSIDE the prep link
                    // so a click on Yes/No never opens the cheatsheet instead.
                    const upcoming = !isPast(event.end);
                    const cancel = upcoming && state !== "declined" ? (
                      <button
                        type="button"
                        onClick={() => setCancelling(event)}
                        className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl px-3 text-[13px] font-medium text-[color:var(--w-ink-soft)] transition-colors hover:bg-[var(--w-stamp-tint)] hover:text-[color:var(--w-stamp)]"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                        {event.isOrganizer ? "Cancel meeting" : "Decline and remove"}
                      </button>
                    ) : null;
                    const rsvp = !event.isOrganizer && upcoming ? (
                      <div className={RSVP_SKIN}>
                        <RsvpControls
                          compact={event.myResponseStatus !== "needsAction"}
                          event={{ ...event, myResponseStatus: event.myResponseStatus ?? "needsAction" }}
                          onChanged={(st) => onAnswered(event.id, st)}
                        />
                      </div>
                    ) : null;
                    const footer = rsvp || cancel ? (
                      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--w-tray)] pt-3">
                        {rsvp ?? <span />}
                        {cancel}
                      </div>
                    ) : null;
                    return (
                      <article
                        key={event.id}
                        className={`basil-rise ${preppable ? "basil-lift" : ""} ${CARD} ${CARD_EDGE[state] ?? ""} flex flex-col gap-3 p-4 sm:p-5`}
                        style={{ animationDelay: `${280 + Math.min(order.get(event.id) ?? 0, 12) * 70}ms` }}
                      >
                        {preppable ? (
                          <Link
                            href={`/dashboard/meetings/${event.id}`}
                            className="flex flex-wrap items-center gap-4 rounded-[14px] text-[color:var(--w-ink)] no-underline"
                          >
                            {body}
                          </Link>
                        ) : (
                          <div className="flex flex-wrap items-center gap-4">{body}</div>
                        )}
                        {footer}
                      </article>
                    );
                  })}
                </section>
              ))
            )}
          </div>
        ))}
        {/* end of UPCOMING TAB — closes `{activeTab === "upcoming" && (…)}` */}
      </div>
    </div>
  );
}
