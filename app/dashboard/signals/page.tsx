"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Mail,
  Hash,
  CircleDot,
  Zap,
  Users,
  MessageSquare,
  Clock,
  CheckSquare,
  TrendingUp,
  TrendingDown,
  Minus,
  AlertCircle,
  ChevronLeft,
  BookOpen,
  FileText,
  Send,
  TriangleAlert,
  History,
  Layers,
  Calendar,
  Video,
  MapPin,
  Activity,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { basilFetch } from "@/lib/basil-fetch";
import { Skeleton } from "@/components/ui/skeleton";
import { TrustTierBadge, FreshnessTag } from "@/components/ui/trust-ui";
import {
  ThreadHealthBadge,
  ThreadHealthPanel,
  ThreadHealthSummaryLine,
} from "@/components/ui/thread-health";
import { computeThreadHealth, inputFromThread } from "@/lib/relationship/score";
import type { SignalThread, SignalThreadStatus } from "@/core/primitives/signal-thread";
import type { CalendarEvent } from "@/lib/google/calendar";

// ── API response types ────────────────────────────────────────────────────────

interface ThreadsResponse {
  threads: SignalThread[];
  total: number;
  page: { offset: number; limit: number; returned: number };
  flagsActive: { signalThread_active: boolean };
  hint?: string;
}

interface CalendarResponse {
  connected: boolean;
  events: CalendarEvent[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function relTime(d: string): string {
  try {
    const diff = Date.now() - new Date(d).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "now";
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d`;
    const wks = Math.floor(days / 7);
    return `${wks}w`;
  } catch {
    return "—";
  }
}

function daysSince(d: string): number {
  try {
    return Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
  } catch {
    return 0;
  }
}

function formatEventTime(start: string): string {
  try {
    const d = new Date(start);
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);

    const isToday = d.toDateString() === now.toDateString();
    const isTomorrow = d.toDateString() === tomorrow.toDateString();

    const timeStr = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

    if (isToday) return `Today ${timeStr}`;
    if (isTomorrow) return `Tomorrow ${timeStr}`;

    return d.toLocaleDateString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
    }) + ` ${timeStr}`;
  } catch {
    return "—";
  }
}

/**
 * Fuzzy-match a calendar event attendee list against thread participants.
 * Matches on local-part of email address OR display name fragment.
 */
function matchesParticipants(
  event: CalendarEvent,
  rawParticipants: string[]
): boolean {
  if (rawParticipants.length === 0) return false;

  // Build normalised token set from thread participants
  const tokens = rawParticipants.flatMap((p) => {
    const parts: string[] = [];
    const lower = p.toLowerCase().trim();
    const atIdx = lower.indexOf("@");
    if (atIdx > -1) {
      parts.push(lower.slice(0, atIdx)); // local-part
      parts.push(lower);                 // full email
    } else {
      // Name — split into words
      lower.split(/\s+/).forEach((w) => { if (w.length > 2) parts.push(w); });
    }
    return parts;
  });

  return event.attendees.some((attendee) => {
    const a = attendee.toLowerCase();
    return tokens.some((t) => a.includes(t));
  });
}

// ── Source icon ───────────────────────────────────────────────────────────────

function SourceIcon({ source, className }: { source: string; className?: string }) {
  switch (source) {
    case "gmail":
    case "outlook":
      return <Mail className={cn("h-3.5 w-3.5 text-blue-500/70", className)} />;
    case "slack":
    case "teams":
      return <Hash className={cn("h-3.5 w-3.5 text-amber-500/80", className)} />;
    case "linear":
      return <CircleDot className={cn("h-3.5 w-3.5 text-violet-500/70", className)} />;
    default:
      return <Zap className={cn("h-3.5 w-3.5 text-muted-foreground/50", className)} />;
  }
}

// ── Category label + colour ───────────────────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  action_required:      "Action",
  decision_made:        "Decision",
  relationship_signal:  "Relationship",
  commercial_signal:    "Commercial",
  meeting_intelligence: "Meeting",
  document_activity:    "Document",
  issue_update:         "Issue",
  low_value_noise:      "Noise",
  unknown:              "Unknown",
};

const CATEGORY_CLASS: Record<string, string> = {
  action_required:      "bg-amber-500/10 text-amber-600",
  decision_made:        "bg-emerald-500/10 text-emerald-600",
  relationship_signal:  "bg-blue-500/10 text-blue-600",
  commercial_signal:    "bg-[oklch(0.72_0.15_85)]/15 text-[oklch(0.58_0.15_85)]",
  meeting_intelligence: "bg-violet-500/10 text-violet-600",
  document_activity:    "bg-muted text-muted-foreground",
  issue_update:         "bg-muted text-muted-foreground",
  low_value_noise:      "bg-muted text-muted-foreground/50",
  unknown:              "bg-muted text-muted-foreground/50",
};

// Thread urgency: derived from category + staleness
function threadUrgency(t: SignalThread): "critical" | "high" | "medium" | "low" {
  const days = daysSince(t.lastSignalAt);
  if (t.category === "action_required" && days < 3) return "critical";
  if (t.category === "action_required") return "high";
  if (t.category === "commercial_signal" && t.actionIds.length > 0) return "high";
  if (t.category === "meeting_intelligence" && days < 1) return "high";
  if (days > 14 && t.status === "open") return "medium";
  if (t.actionIds.length > 0) return "medium";
  return "low";
}

// Derive a relationship state label from thread health + recency
function relationshipState(thread: SignalThread): {
  label: string;
  colorClass: string;
  description: string;
} {
  const days = daysSince(thread.lastSignalAt);
  const health = computeThreadHealth(inputFromThread(thread));

  if (thread.status === "closed") {
    return { label: "Closed", colorClass: "text-muted-foreground", description: "Thread concluded" };
  }

  if (days < 1) {
    return { label: "Active", colorClass: "text-emerald-500", description: "Active today" };
  }
  if (days < 3) {
    return { label: "Active", colorClass: "text-emerald-500", description: `Last: ${days}d ago` };
  }
  if (days < 7) {
    return { label: "Warm", colorClass: "text-[oklch(0.72_0.15_85)]", description: `Last: ${days}d ago` };
  }
  if (days < 14) {
    if (health.reliable && health.score < 0.4) {
      return { label: "Cooling", colorClass: "text-amber-500", description: "Low engagement" };
    }
    return { label: "Quiet", colorClass: "text-muted-foreground", description: `${days}d since activity` };
  }
  return { label: "At risk", colorClass: "text-red-500", description: `${days}d silent` };
}

const URGENCY_BAR: Record<string, string> = {
  critical: "bg-red-500",
  high:     "bg-amber-400",
  medium:   "bg-[oklch(0.72_0.15_85)]",
  low:      "bg-border",
};

const STATUS_CHIP: Record<SignalThreadStatus, { label: string; class: string }> = {
  open:   { label: "Open",   class: "bg-emerald-500/10 text-emerald-600" },
  stale:  { label: "Stale",  class: "bg-amber-500/10 text-amber-600" },
  closed: { label: "Closed", class: "bg-muted text-muted-foreground" },
};

// ── Participant display ───────────────────────────────────────────────────────

function participantLabel(name: string): string {
  if (!name) return "?";
  const atIdx = name.indexOf("@");
  const clean = atIdx > -1 ? name.slice(0, atIdx) : name;
  const parts = clean.trim().split(/\s+/);
  return parts[0] ?? clean;
}

function ParticipantAvatar({ name, size = "sm" }: { name: string; size?: "sm" | "md" }) {
  const label = participantLabel(name);
  const initials = label.length > 0 ? label[0].toUpperCase() : "?";
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-full bg-[oklch(0.72_0.15_85)]/20 text-[oklch(0.72_0.15_85)] font-medium shrink-0",
        size === "sm" ? "h-6 w-6 text-[11px]" : "h-8 w-8 text-[13px]"
      )}
      title={name}
    >
      {initials}
    </span>
  );
}

// ── Activity trend (list item) ────────────────────────────────────────────────

function ActivityTrend({ thread }: { thread: SignalThread }) {
  const days = daysSince(thread.lastSignalAt);
  if (days < 1) return <TrendingUp className="h-3.5 w-3.5 text-emerald-500" aria-label="Active now" />;
  if (days < 3) return <TrendingUp className="h-3.5 w-3.5 text-[oklch(0.72_0.15_85)]" aria-label="Active recently" />;
  if (days < 7) return <Minus className="h-3.5 w-3.5 text-muted-foreground" aria-label="Quiet" />;
  return <TrendingDown className="h-3.5 w-3.5 text-amber-500" aria-label="Going stale" />;
}

// ── Linked meetings ───────────────────────────────────────────────────────────

function LinkedMeetings({
  thread,
  events,
  loading,
}: {
  thread: SignalThread;
  events: CalendarEvent[] | null;
  loading: boolean;
}) {
  if (loading) {
    return (
      <section>
        <p className="basil-eyebrow mb-3">Linked Meetings</p>
        <div className="space-y-2">
          <Skeleton className="h-14 rounded-lg" />
          <Skeleton className="h-14 rounded-lg" />
        </div>
      </section>
    );
  }

  if (!events) return null;

  const linked = events
    .filter((ev) => !ev.isAllDay && matchesParticipants(ev, thread.rawParticipants))
    .slice(0, 3);

  if (linked.length === 0) return null;

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <p className="basil-eyebrow">Linked Meetings</p>
        <span className="text-[11px] font-mono text-muted-foreground/60 tabular-nums">
          {linked.length} upcoming
        </span>
      </div>
      <div className="space-y-2">
        {linked.map((ev) => (
          <div
            key={ev.id}
            className="rounded-lg bg-card/60 border border-border/60 px-3 py-2.5"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-start gap-2 min-w-0">
                <Calendar className="h-3.5 w-3.5 text-violet-500/70 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-foreground leading-snug truncate">
                    {ev.summary}
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {formatEventTime(ev.start)}
                    {ev.attendeeCount > 0 && (
                      <span className="ml-2 inline-flex items-center gap-0.5">
                        <Users className="h-2.5 w-2.5" />
                        {ev.attendeeCount + 1}
                      </span>
                    )}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {ev.hasVideo && (
                  <span className="rounded bg-violet-500/10 text-violet-500 p-1" title="Video call">
                    <Video className="h-2.5 w-2.5" />
                  </span>
                )}
                {ev.location && !ev.hasVideo && (
                  <span className="rounded bg-muted text-muted-foreground p-1" title={ev.location}>
                    <MapPin className="h-2.5 w-2.5" />
                  </span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Signal cadence bar ────────────────────────────────────────────────────────

/**
 * Visual representation of signal density over the thread's lifetime.
 * Uses signalCount and thread age to infer a rough cadence score.
 */
function CadenceBar({ thread }: { thread: SignalThread }) {
  const ageDays = Math.max(daysSince(thread.firstSignalAt), 1);
  const perWeek = (thread.signalCount / ageDays) * 7;

  // Map to 1–5 filled bars
  const bars = Math.min(5, Math.max(1, Math.round(perWeek)));
  const colorClass =
    bars >= 4 ? "bg-emerald-500"
    : bars >= 3 ? "bg-[oklch(0.72_0.15_85)]"
    : bars >= 2 ? "bg-amber-500/70"
    : "bg-border";

  return (
    <div className="flex items-end gap-0.5 h-4" title={`~${perWeek.toFixed(1)} signals/week`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <span
          key={i}
          className={cn(
            "w-1.5 rounded-sm transition-all",
            i < bars ? colorClass : "bg-border/40",
            // Varying heights for visual interest
            i === 0 ? "h-2" : i === 1 ? "h-2.5" : i === 2 ? "h-3" : i === 3 ? "h-3.5" : "h-4"
          )}
        />
      ))}
    </div>
  );
}

// ── Thread list item ──────────────────────────────────────────────────────────

function ThreadListItem({
  thread,
  selected,
  onClick,
}: {
  thread: SignalThread;
  selected: boolean;
  onClick: () => void;
}) {
  const urgency = threadUrgency(thread);
  const status = STATUS_CHIP[thread.status];
  const health = computeThreadHealth(inputFromThread(thread));

  return (
    <button
      onClick={onClick}
      className={cn(
        "group relative w-full text-left rounded-lg px-3 py-3 transition-colors",
        selected
          ? "bg-[oklch(0.72_0.15_85)]/10 border border-[oklch(0.72_0.15_85)]/20"
          : "hover:bg-accent/50 border border-transparent"
      )}
    >
      {/* Priority bar */}
      <span
        className={cn(
          "absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full",
          URGENCY_BAR[urgency]
        )}
      />

      <div className="pl-1.5">
        {/* Top row: source icon + title + time */}
        <div className="flex items-start gap-2 mb-1">
          <SourceIcon source={thread.primarySource} className="mt-0.5 shrink-0" />
          <span className="text-[13px] font-medium text-foreground leading-snug flex-1 min-w-0 line-clamp-2">
            {thread.title}
          </span>
          <span className="text-[11px] font-mono text-muted-foreground shrink-0 tabular-nums ml-1 mt-0.5">
            {relTime(thread.lastSignalAt)}
          </span>
        </div>

        {/* Middle row: participants */}
        {thread.rawParticipants.length > 0 && (
          <p className="text-[12px] text-muted-foreground truncate pl-5 mb-1.5">
            {thread.rawParticipants.slice(0, 3).map(participantLabel).join(", ")}
            {thread.rawParticipants.length > 3 && ` +${thread.rawParticipants.length - 3}`}
          </p>
        )}

        {/* Bottom row: badges + health */}
        <div className="flex items-center gap-1.5 pl-5 flex-wrap">
          <span className={cn("rounded-sm text-[11px] font-mono uppercase tracking-wider px-1.5 py-0.5", status.class)}>
            {status.label}
          </span>
          <span className={cn("rounded-sm text-[11px] font-mono uppercase tracking-wider px-1.5 py-0.5", CATEGORY_CLASS[thread.category] ?? "bg-muted text-muted-foreground")}>
            {CATEGORY_LABELS[thread.category] ?? thread.category}
          </span>
          {thread.actionIds.length > 0 ? (
            <span className="flex items-center gap-0.5 text-[11px] text-muted-foreground">
              <CheckSquare className="h-2.5 w-2.5" />
              {thread.actionIds.length}
            </span>
          ) : null}
        </div>

        {/* Health summary line */}
        {health.reliable ? (
          <div className="pl-5 mt-1.5">
            <ThreadHealthSummaryLine health={health} />
          </div>
        ) : null}
      </div>
    </button>
  );
}

// ── Thread detail ─────────────────────────────────────────────────────────────

function ThreadDetail({
  thread,
  calendarEvents,
  calendarLoading,
  onBack,
}: {
  thread: SignalThread;
  calendarEvents: CalendarEvent[] | null;
  calendarLoading: boolean;
  onBack?: () => void;
}) {
  const router = useRouter();
  const urgency = threadUrgency(thread);
  const status = STATUS_CHIP[thread.status];
  const categoryLabel = CATEGORY_LABELS[thread.category] ?? thread.category;
  const relState = relationshipState(thread);

  // Compute thread health from available signals
  const health = computeThreadHealth(inputFromThread(thread));

  const chatHref = (q: string) =>
    `/dashboard/chat?q=${encodeURIComponent(q)}`;

  const ACTIONS = [
    {
      icon: <BookOpen className="h-3.5 w-3.5" />,
      label: "Prepare me",
      description: "What to know before engaging",
      query: `Prepare me for the thread: "${thread.title}". Summarise what's happening, who the key people are, and what I need to know before engaging.`,
    },
    {
      icon: <FileText className="h-3.5 w-3.5" />,
      label: "Summarise",
      description: "Status and key points",
      query: `Give me a concise summary of the thread "${thread.title}" — what's been discussed, any decisions made, and current status.`,
    },
    {
      icon: <Send className="h-3.5 w-3.5" />,
      label: "Draft response",
      description: "Write a reply for this thread",
      query: `Draft a response for the thread "${thread.title}". Base it on context you have and ask me for any missing details.`,
    },
    {
      icon: <TriangleAlert className="h-3.5 w-3.5" />,
      label: "Show risks",
      description: "What could go wrong",
      query: `What are the risks or open issues in the thread "${thread.title}"? What could go wrong or what's being left unaddressed?`,
    },
    {
      icon: <History className="h-3.5 w-3.5" />,
      label: "Relationship history",
      description: "Background on these people",
      query: `Give me the relationship history and context with the people in the thread "${thread.title}". Who are they, how have they engaged, and what should I know?`,
    },
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-5 pt-5 pb-4 border-b border-border/60">
        {/* Mobile back button */}
        {onBack && (
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground mb-3 transition-colors"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Threads
          </button>
        )}

        {/* Urgency strip */}
        <div className={cn("h-0.5 w-full rounded-full mb-4", URGENCY_BAR[urgency])} />

        {/* Title */}
        <h2 className="text-base font-semibold leading-snug text-foreground mb-3">
          {thread.title}
        </h2>

        {/* Meta badges */}
        <div className="flex flex-wrap gap-1.5 mb-3">
          <span className={cn("rounded-md text-[11px] font-mono uppercase tracking-wider px-2 py-0.5", status.class)}>
            {status.label}
          </span>
          <span className={cn("rounded-md text-[11px] font-mono uppercase tracking-wider px-2 py-0.5", CATEGORY_CLASS[thread.category] ?? "bg-muted text-muted-foreground")}>
            {categoryLabel}
          </span>
          {thread.sources.map((src) => (
            <span key={src} className="inline-flex items-center gap-1 rounded-md bg-muted text-muted-foreground text-[11px] font-mono uppercase tracking-wider px-2 py-0.5">
              <SourceIcon source={src} className="h-2.5 w-2.5" />
              {src}
            </span>
          ))}
        </div>

        {/* Participants strip */}
        {thread.rawParticipants.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <Users className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <div className="flex items-center gap-1.5 flex-wrap">
              {thread.rawParticipants.map((p) => (
                <div key={p} className="flex items-center gap-1">
                  <ParticipantAvatar name={p} size="sm" />
                  <span className="text-[12px] text-muted-foreground">{participantLabel(p)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">

        {/* ── Operational state ─────────────────────────────────────────── */}
        <section>
          <p className="basil-eyebrow mb-3">Operational State</p>
          <div className="grid grid-cols-3 gap-3">
            {/* Urgency */}
            <div className="rounded-lg bg-card/60 border border-border/60 px-3 py-2.5 text-center">
              <p className="text-[10px] text-muted-foreground mb-1 uppercase tracking-wider font-medium">Urgency</p>
              <p className={cn(
                "text-[13px] font-semibold capitalize",
                urgency === "critical" ? "text-red-500"
                  : urgency === "high" ? "text-amber-500"
                  : urgency === "medium" ? "text-[oklch(0.72_0.15_85)]"
                  : "text-muted-foreground"
              )}>
                {urgency}
              </p>
            </div>

            {/* Trust */}
            <div className="rounded-lg bg-card/60 border border-border/60 px-3 py-2.5 text-center">
              <p className="text-[10px] text-muted-foreground mb-1.5 uppercase tracking-wider font-medium">Trust</p>
              <div className="flex justify-center">
                <TrustTierBadge tier={thread.trustTier} />
              </div>
            </div>

            {/* Relationship state */}
            <div className="rounded-lg bg-card/60 border border-border/60 px-3 py-2.5 text-center">
              <p className="text-[10px] text-muted-foreground mb-1 uppercase tracking-wider font-medium">State</p>
              <p className={cn("text-[13px] font-semibold", relState.colorClass)}>
                {relState.label}
              </p>
            </div>
          </div>

          {/* Activity cadence row */}
          <div className="mt-2 rounded-lg bg-card/60 border border-border/60 px-3 py-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Activity className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-[12px] text-muted-foreground">Signal cadence</span>
              </div>
              <div className="flex items-center gap-3">
                <CadenceBar thread={thread} />
                <span className="text-[11px] font-mono text-muted-foreground tabular-nums">
                  {thread.signalCount} total · {relState.description}
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* ── Relationship health ────────────────────────────────────────── */}
        <section>
          <p className="basil-eyebrow mb-3">Relationship Health</p>
          <ThreadHealthPanel
            health={health}
            threadTitle={thread.title}
            showAlerts
          />

          {/* Thread metadata */}
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 px-1">
            <div className="flex items-center justify-between col-span-2 text-[12px] text-muted-foreground border-t border-border/30 pt-2 mt-1">
              <span className="flex items-center gap-1.5">
                <Layers className="h-3 w-3" />
                {thread.signalCount} total signals
              </span>
              <span className="flex items-center gap-1.5">
                <Clock className="h-3 w-3" />
                Since {new Date(thread.firstSignalAt).toLocaleDateString("en-GB", {
                  day: "numeric", month: "short", year: "numeric"
                })}
              </span>
            </div>
          </div>
        </section>

        {/* ── Unresolved commitments ────────────────────────────────────── */}
        {thread.actionIds.length > 0 && (
          <section>
            <div className="flex items-center justify-between mb-3">
              <p className="basil-eyebrow">Unresolved Commitments</p>
              <Link
                href="/dashboard/actions"
                className="text-[12px] text-[oklch(0.72_0.15_85)] hover:underline"
              >
                View all →
              </Link>
            </div>
            <div className="rounded-lg bg-card/60 border border-amber-500/20 px-3 py-2.5">
              <div className="flex items-center gap-2 text-[13px]">
                <CheckSquare className="h-4 w-4 text-amber-500 shrink-0" />
                <span className="text-foreground">
                  <span className="font-semibold">{thread.actionIds.length} open action{thread.actionIds.length !== 1 ? "s" : ""}</span>
                  <span className="text-muted-foreground"> from this thread</span>
                </span>
              </div>
            </div>
          </section>
        )}

        {/* ── Decisions ─────────────────────────────────────────────────── */}
        {thread.decisionIds.length > 0 && (
          <section>
            <div className="flex items-center justify-between mb-3">
              <p className="basil-eyebrow">Decisions</p>
              <Link
                href="/dashboard/decisions"
                className="text-[12px] text-[oklch(0.72_0.15_85)] hover:underline"
              >
                View all →
              </Link>
            </div>
            <div className="rounded-lg bg-card/60 border border-border/60 px-3 py-2.5">
              <div className="flex items-center gap-2 text-[13px]">
                <Zap className="h-4 w-4 text-[oklch(0.72_0.15_85)] shrink-0" />
                <span className="text-foreground">
                  <span className="font-semibold">{thread.decisionIds.length} decision{thread.decisionIds.length !== 1 ? "s" : ""}</span>
                  <span className="text-muted-foreground"> logged from this thread</span>
                </span>
              </div>
            </div>
          </section>
        )}

        {/* ── Linked meetings ────────────────────────────────────────────── */}
        <LinkedMeetings
          thread={thread}
          events={calendarEvents}
          loading={calendarLoading}
        />

        {/* ── Projects ──────────────────────────────────────────────────── */}
        {thread.projects.length > 0 && (
          <section>
            <p className="basil-eyebrow mb-3">Linked Projects</p>
            <div className="flex flex-wrap gap-1.5">
              {thread.projects.map((p) => (
                <span
                  key={p}
                  className="rounded-md bg-[oklch(0.72_0.15_85)]/10 text-[oklch(0.58_0.15_85)] text-[12px] font-medium px-2.5 py-1"
                >
                  {p}
                </span>
              ))}
            </div>
          </section>
        )}

        {/* ── Action bar ────────────────────────────────────────────────── */}
        <section>
          <p className="basil-eyebrow mb-3">Ask Basil</p>
          <div className="grid grid-cols-1 gap-2">
            {ACTIONS.map((action) => (
              <button
                key={action.label}
                onClick={() => router.push(chatHref(action.query))}
                className="flex items-center gap-3 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5 text-left hover:bg-[oklch(0.72_0.15_85)]/8 hover:border-[oklch(0.72_0.15_85)]/30 transition-colors group"
              >
                <span className="text-muted-foreground group-hover:text-[oklch(0.72_0.15_85)] transition-colors shrink-0">
                  {action.icon}
                </span>
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-foreground leading-none mb-0.5">{action.label}</p>
                  <p className="text-[11px] text-muted-foreground">{action.description}</p>
                </div>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

// ── Empty / flag-off state ────────────────────────────────────────────────────

function SignalThreadsEmpty({ hint }: { hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full py-20 text-center px-8">
      <div className="h-14 w-14 rounded-xl bg-[oklch(0.72_0.15_85)]/10 flex items-center justify-center mb-4">
        <MessageSquare className="h-6 w-6 text-[oklch(0.72_0.15_85)]/70" />
      </div>
      <h3 className="text-base font-semibold text-foreground mb-2">No signal threads yet</h3>
      <p className="text-sm text-muted-foreground max-w-xs leading-relaxed">
        {hint ?? "Signal threads surface once Basil has processed enough signals to group them into conversations."}
      </p>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SignalsPage() {
  const [threads, setThreads] = useState<SignalThread[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [flagActive, setFlagActive] = useState<boolean | null>(null);
  const [hint, setHint] = useState<string | undefined>();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showDetail, setShowDetail] = useState(false);

  // Calendar state — loaded once on mount, used for linked-meeting matching
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[] | null>(null);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const calendarFetched = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await basilFetch<ThreadsResponse>(
        "/api/signals/threads?limit=100",
        { component: "SignalsPage" }
      );
      setFlagActive(data.flagsActive.signalThread_active);
      setThreads(data.threads);
      setTotal(data.total);
      setHint(data.hint);

      if (data.threads.length > 0 && !selectedId) {
        setSelectedId(data.threads[0].id);
      }
    } catch (err) {
      console.error("[signals-page] fetch failed", err);
      setFlagActive(false);
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch calendar events once (for linked-meeting matching)
  const loadCalendar = useCallback(async () => {
    if (calendarFetched.current) return;
    calendarFetched.current = true;
    setCalendarLoading(true);
    try {
      const data = await basilFetch<CalendarResponse>(
        "/api/calendar/upcoming",
        { component: "SignalsPage.calendar" }
      );
      if (data.connected) {
        setCalendarEvents(data.events);
      } else {
        setCalendarEvents([]);
      }
    } catch {
      setCalendarEvents([]);
    } finally {
      setCalendarLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Load calendar when a thread is first selected
  useEffect(() => {
    if (selectedId) {
      loadCalendar();
    }
  }, [selectedId, loadCalendar]);

  const selectedThread = threads.find((t) => t.id === selectedId) ?? null;

  // ── Loading skeleton ──────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex h-full">
        <div className="w-80 border-r border-border/60 p-3 space-y-2 shrink-0">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="rounded-lg p-3 space-y-2">
              <Skeleton className="h-3.5 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          ))}
        </div>
        <div className="flex-1 p-5 space-y-4">
          <Skeleton className="h-0.5 w-full rounded-full" />
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-3 w-1/4" />
          <div className="grid grid-cols-3 gap-3 mt-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-16 rounded-lg" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── Flag off / empty ──────────────────────────────────────────────────────
  if (!flagActive || threads.length === 0) {
    return (
      <div className="h-full flex flex-col">
        <div className="px-4 sm:px-6 lg:px-10 pt-6 pb-4 border-b border-border/60">
          <div className="max-w-[1400px] mx-auto flex items-center justify-between">
            <div>
              <p className="basil-eyebrow">Signals</p>
              <h1 className="basil-display text-2xl text-foreground mt-1">Thread Intelligence</h1>
            </div>
          </div>
        </div>
        <div className="flex-1">
          <SignalThreadsEmpty hint={hint} />
        </div>
      </div>
    );
  }

  // ── Main layout: list + detail ────────────────────────────────────────────
  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Thread list ───────────────────────────────────────────────────── */}
      <div
        className={cn(
          "flex flex-col border-r border-border/60 bg-background shrink-0",
          "lg:w-[320px] xl:w-[360px]",
          showDetail ? "hidden lg:flex" : "flex w-full"
        )}
      >
        <div className="px-4 pt-5 pb-3 border-b border-border/60 shrink-0">
          <div className="flex items-center justify-between mb-1">
            <p className="basil-eyebrow">Threads</p>
            <span className="text-[11px] font-mono text-muted-foreground tabular-nums">
              {total} total
            </span>
          </div>
          <h1 className="basil-display text-xl text-foreground">Thread Intelligence</h1>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {threads.map((t) => (
            <ThreadListItem
              key={t.id}
              thread={t}
              selected={t.id === selectedId}
              onClick={() => {
                setSelectedId(t.id);
                setShowDetail(true);
              }}
            />
          ))}
        </div>
      </div>

      {/* ── Thread detail ─────────────────────────────────────────────────── */}
      <div
        className={cn(
          "flex-1 bg-background overflow-hidden",
          showDetail ? "flex flex-col" : "hidden lg:flex lg:flex-col"
        )}
      >
        {selectedThread ? (
          <ThreadDetail
            thread={selectedThread}
            calendarEvents={calendarEvents}
            calendarLoading={calendarLoading}
            onBack={() => setShowDetail(false)}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center px-8">
            <MessageSquare className="h-8 w-8 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">Select a thread to see details</p>
          </div>
        )}
      </div>
    </div>
  );
}
