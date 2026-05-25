"use client";

/**
 * AttentionLayer — operational priority surface for the Basil homepage.
 *
 * Answers: "What requires my attention right now?"
 *
 * Six signal classes, in score order:
 *   1. Commitments  — overdue or due-today actions
 *   2. Blockers     — events flagged urgent/escalated
 *   3. Approvals    — pending Basil drafts awaiting sign-off
 *   4. Silence      — stakeholders gone quiet (dynamic, not hardcoded)
 *   5. Meetings     — imminent meetings needing prep (<3h)
 *   6. Pressure     — tomorrow's high-stakes meetings needing prep
 *
 * Design rules:
 *   - No counts for their own sake — only what requires action
 *   - Priority through left-bar colour, not text weight
 *   - One CTA per item, no ambiguity
 *   - Empty state is calm, not apologetic
 *   - No hardcoded contact names — contact relevance is derived from activity data
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  CheckSquare,
  Clock,
  Users,
  Calendar,
  AlertTriangle,
  ArrowRight,
  RefreshCw,
  Sparkles,
  MessageSquare,
  CalendarClock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ApprovalPanel } from "./approval-panel";
import type { ActionItem } from "@/lib/types/action";
import type { BasilEvent } from "@/lib/events/types";
import { useMode } from "@/components/ui/mode-context";

// ── Attention taxonomy ────────────────────────────────────────────────────────

type AttentionType =
  | "commitment"
  | "approval"
  | "blocker"
  | "silence"
  | "meeting"
  | "pressure";

type AttentionPriority = "critical" | "high" | "medium" | "low";

interface AttentionItem {
  id: string;
  type: AttentionType;
  priority: AttentionPriority;
  score: number;
  title: string;
  context: string;
  timeLabel?: string;
  href?: string;
  cta: string;
  openPanel?: boolean;
  eventId?: string;
}

// ── Visual config ─────────────────────────────────────────────────────────────

const PRIORITY_BAR: Record<AttentionPriority, string> = {
  critical: "bg-red-500",
  high:     "bg-amber-400",
  medium:   "bg-[oklch(0.72_0.15_85)]",
  low:      "bg-border",
};

const TYPE_CONFIG: Record<AttentionType, {
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  labelClass: string;
}> = {
  commitment: { label: "Commitment",  Icon: CheckSquare,    labelClass: "text-red-400" },
  approval:   { label: "Approval",    Icon: Clock,          labelClass: "text-amber-400" },
  blocker:    { label: "Blocker",     Icon: AlertTriangle,  labelClass: "text-red-400" },
  silence:    { label: "Silence",     Icon: MessageSquare,  labelClass: "text-sky-400" },
  meeting:    { label: "Meeting",     Icon: Calendar,       labelClass: "text-[oklch(0.72_0.15_85)]" },
  pressure:   { label: "Prep needed", Icon: CalendarClock,  labelClass: "text-violet-400" },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function relTime(d: string | null | undefined): string {
  if (!d) return "";
  const diff = Date.now() - new Date(d).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function dueLabel(d: string): string {
  const today = new Date().toISOString().slice(0, 10);
  if (d < today) {
    const days = Math.round((new Date(today).getTime() - new Date(d).getTime()) / 86400000);
    return days === 1 ? "1d overdue" : `${days}d overdue`;
  }
  if (d === today) return "due today";
  const days = Math.round((new Date(d).getTime() - new Date(today).getTime()) / 86400000);
  return days === 1 ? "due tomorrow" : `due in ${days}d`;
}

function minsUntil(start: string): number {
  return Math.floor((new Date(start).getTime() - Date.now()) / 60000);
}

function isTomorrow(start: string): boolean {
  const startDay = new Date(start).toISOString().slice(0, 10);
  const tomorrowDay = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  return startDay === tomorrowDay;
}

// ── Raw API types ─────────────────────────────────────────────────────────────

interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  attendeeCount?: number;
  hasVideo?: boolean;
  isAllDay?: boolean;
}

interface ContactActivity {
  contactId: string;
  name: string;
  lastInteraction: string | null;
  sources: string[];
}

// ── Dynamic key-contact detection ─────────────────────────────────────────────
//
// No hardcoded names. Key contacts are derived from interaction data:
//   - Sort all contacts by most recently interacted (descending)
//   - The top tier (most active in last 60d) get a tighter silence threshold
//   - Lower tiers get progressively wider thresholds
//
// Tier thresholds (days since last interaction):
//   Top 5  contacts → flag at > 7d
//   Top 15 contacts → flag at > 14d
//   All others      → flag at > 30d

function classifyContactsByActivity(contacts: ContactActivity[]): Array<{
  contact: ContactActivity;
  daysAgo: number;
  tier: 1 | 2 | 3;
  threshold: number;
}> {
  const SIXTY_DAYS = 60 * 86400000;
  const now = Date.now();

  // Only consider contacts with at least one interaction in the last 60 days
  const active = contacts
    .filter((c) => c.lastInteraction &&
      now - new Date(c.lastInteraction).getTime() < SIXTY_DAYS)
    .map((c) => ({
      contact: c,
      daysAgo: (now - new Date(c.lastInteraction!).getTime()) / 86400000,
    }))
    .sort((a, b) => a.daysAgo - b.daysAgo); // most recent first

  return active.map((item, idx) => {
    const tier: 1 | 2 | 3 = idx < 5 ? 1 : idx < 15 ? 2 : 3;
    const threshold = tier === 1 ? 7 : tier === 2 ? 14 : 30;
    return { ...item, tier, threshold };
  });
}

// ── Scoring + aggregation ─────────────────────────────────────────────────────

function buildAttentionItems(
  actions: ActionItem[],
  events: BasilEvent[],
  contacts: ContactActivity[],
  calendar: CalendarEvent[],
): AttentionItem[] {
  const items: AttentionItem[] = [];
  const today = new Date().toISOString().slice(0, 10);

  // ── 1. Commitments (open / overdue actions) ───────────────────────────────
  const openActions = actions
    .filter((a) => a.status !== "done" && !a.needsReview)
    .sort((a, b) => {
      const aOverdue = a.status === "overdue" || (a.dueDate && a.dueDate < today) ? 1 : 0;
      const bOverdue = b.status === "overdue" || (b.dueDate && b.dueDate < today) ? 1 : 0;
      if (aOverdue !== bOverdue) return bOverdue - aOverdue;
      const pOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
      return (pOrder[a.priority ?? "low"] ?? 2) - (pOrder[b.priority ?? "low"] ?? 2);
    })
    .slice(0, 5);

  for (const action of openActions) {
    const isOverdue = action.status === "overdue" ||
      (action.dueDate != null && action.dueDate < today);
    const isDueToday  = action.dueDate === today;
    const isDueTomorrow = action.dueDate === new Date(Date.now() + 86400000).toISOString().slice(0, 10);

    let priority: AttentionPriority;
    let score: number;

    if (isOverdue)          { priority = "critical"; score = 100; }
    else if (isDueToday)    { priority = "high";     score = 88;  }
    else if (isDueTomorrow) { priority = "high";     score = 75;  }
    else if (action.priority === "high") { priority = "medium"; score = 64; }
    else                    { priority = "low";      score = 36;  }

    // Suppress low-signal admin noise from homepage
    if (priority === "low" && action.category === "admin") continue;

    const contextParts: string[] = [];
    if (action.category === "critical") contextParts.push("Critical");
    if (action.source) contextParts.push(action.source);
    if (action.owner?.trim()) contextParts.push(action.owner);

    items.push({
      id: `action-${action.id}`,
      type: "commitment",
      priority,
      score,
      title: action.text,
      context: contextParts.join(" · "),
      timeLabel: action.dueDate ? dueLabel(action.dueDate) : relTime(action.createdAt),
      href: "/dashboard/actions",
      cta: "Open",
    });
  }

  // ── 2. Blockers (urgent / escalated notify events) ────────────────────────
  const blockerEvents = events.filter((e) => {
    if (e.disposition !== "notify" || e.status === "acknowledged") return false;
    const hl = (e.headline + " " + (e.rationale ?? "")).toLowerCase();
    return hl.includes("block") || hl.includes("escalat") ||
           hl.includes("urgent") || hl.includes("stuck") || hl.includes("at risk");
  }).slice(0, 2);

  for (const ev of blockerEvents) {
    items.push({
      id: `blocker-${ev.id}`,
      type: "blocker",
      priority: "critical",
      score: 96,
      title: ev.headline,
      context: ev.rationale ?? `${ev.source} · needs attention`,
      timeLabel: relTime(ev.createdAt),
      cta: "Unblock",
      openPanel: true,
      eventId: ev.id,
    });
  }

  // ── 3. Approvals (pending Basil drafts) ────────────────────────────────────
  const pendingDrafts = events
    .filter((e) => e.disposition === "draft" && e.status === "pending")
    .slice(0, 3);

  for (const ev of pendingDrafts) {
    items.push({
      id: `draft-${ev.id}`,
      type: "approval",
      priority: "high",
      score: 90,
      title: ev.headline,
      context: ev.rationale ?? `${ev.source} · awaiting sign-off`,
      timeLabel: relTime(ev.createdAt),
      cta: "Approve",
      openPanel: true,
      eventId: ev.id,
    });
  }

  // Acknowledge-pending notify items (non-blocker)
  const pendingNotify = events
    .filter((e) => {
      if (e.disposition !== "notify" || e.status === "acknowledged") return false;
      const hl = (e.headline + " " + (e.rationale ?? "")).toLowerCase();
      return !(hl.includes("block") || hl.includes("escalat") ||
               hl.includes("urgent") || hl.includes("stuck") || hl.includes("at risk"));
    })
    .slice(0, 2);

  for (const ev of pendingNotify) {
    items.push({
      id: `notify-${ev.id}`,
      type: "approval",
      priority: "medium",
      score: 56,
      title: ev.headline,
      context: ev.rationale ?? `${ev.source} · heads-up`,
      timeLabel: relTime(ev.createdAt),
      cta: "Review",
      openPanel: true,
      eventId: ev.id,
    });
  }

  // ── 4. Stakeholder silence (dynamic — no hardcoded names) ─────────────────
  const classified = classifyContactsByActivity(contacts);
  const silentContacts = classified
    .filter(({ daysAgo, threshold }) => daysAgo > threshold)
    .sort((a, b) => a.tier - b.tier || b.daysAgo - a.daysAgo)
    .slice(0, 3);

  for (const { contact: c, daysAgo, tier } of silentContacts) {
    const days = Math.floor(daysAgo);
    const priority: AttentionPriority = tier === 1 ? "high" : "medium";
    const score = tier === 1 ? 70 : tier === 2 ? 50 : 34;
    items.push({
      id: `silence-${c.contactId}`,
      type: "silence",
      priority,
      score,
      title: c.name,
      context: `No contact in ${days} days — last via ${c.sources.slice(0, 2).join(", ") || "unknown"}`,
      timeLabel: `${days}d ago`,
      href: "/dashboard/contacts",
      cta: "Reach out",
    });
  }

  // ── 5. Imminent meetings (<3h) ────────────────────────────────────────────
  const imminentMeetings = calendar
    .filter((e) => {
      if (e.isAllDay) return false;
      const mins = minsUntil(e.start);
      return mins > 0 && mins < 180;
    })
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
    .slice(0, 2);

  for (const m of imminentMeetings) {
    const mins = minsUntil(m.start);
    const isClose = mins < 45;
    const timeStr = mins < 60
      ? `in ${mins}m`
      : `in ${Math.floor(mins / 60)}h ${mins % 60 > 0 ? `${mins % 60}m` : ""}`.trim();
    const contextParts = [
      timeStr,
      m.attendeeCount ? `${m.attendeeCount} attendees` : null,
      m.hasVideo ? "video" : null,
    ].filter(Boolean).join(" · ");
    items.push({
      id: `meeting-${m.id}`,
      type: "meeting",
      priority: isClose ? "high" : "medium",
      score: isClose ? 82 : 62,
      title: m.summary,
      context: contextParts,
      timeLabel: timeStr,
      href: "/dashboard/meetings",
      cta: "Prepare",
    });
  }

  // ── 6. Upcoming pressure — tomorrow's multi-attendee or video meetings ─────
  const tomorrowMeetings = calendar
    .filter((e) => {
      if (e.isAllDay) return false;
      return isTomorrow(e.start) &&
        ((e.attendeeCount ?? 0) >= 3 || e.hasVideo);
    })
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
    .slice(0, 2);

  for (const m of tomorrowMeetings) {
    const contextParts = [
      "Tomorrow",
      m.attendeeCount ? `${m.attendeeCount} attendees` : null,
      m.hasVideo ? "video" : null,
    ].filter(Boolean).join(" · ");
    items.push({
      id: `pressure-${m.id}`,
      type: "pressure",
      priority: "low",
      score: 30,
      title: m.summary,
      context: contextParts,
      timeLabel: "tomorrow",
      href: "/dashboard/meetings",
      cta: "Prepare",
    });
  }

  return items
    .sort((a, b) => b.score - a.score)
    .slice(0, 9);
}

// ── Component ─────────────────────────────────────────────────────────────────

export function AttentionLayer() {
  const [actions,  setActions]  = useState<ActionItem[] | null>(null);
  const [events,   setEvents]   = useState<BasilEvent[] | null>(null);
  const [contacts, setContacts] = useState<ContactActivity[] | null>(null);
  const [calendar, setCalendar] = useState<CalendarEvent[] | null>(null);
  const [syncing,  setSyncing]  = useState(false);

  const [panelOpen,  setPanelOpen]  = useState(false);
  const [focusedId,  setFocusedId]  = useState<string | null>(null);

  const load = useCallback(async () => {
    await Promise.allSettled([
      fetch("/api/actions", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => setActions(d?.actions ?? []))
        .catch(() => setActions([])),
      fetch("/api/events?all=1", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => setEvents(d?.events ?? []))
        .catch(() => setEvents([])),
      fetch("/api/contacts/activity", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => setContacts(d?.activity ?? []))
        .catch(() => setContacts([])),
      fetch("/api/calendar", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => setCalendar(d?.events ?? []))
        .catch(() => setCalendar([])),
    ]);
  }, []);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      await fetch("/api/events/poll-ingest", { method: "POST" });
      await load();
    } finally {
      setSyncing(false);
    }
  }, [load]);

  const openPanel = useCallback((eventId?: string) => {
    setFocusedId(eventId ?? null);
    setPanelOpen(true);
  }, []);

  const closePanel = useCallback(() => {
    setPanelOpen(false);
    setFocusedId(null);
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const es = new EventSource("/api/events/stream");
    es.onmessage = () => { void load(); };
    return () => es.close();
  }, [load]);

  const { shouldShowAttention, attentionTypeWeight, isDefault, mode } = useMode();

  const items = useMemo(() => {
    if (!actions || !events || !contacts || !calendar) return null;
    const all = buildAttentionItems(actions, events, contacts, calendar);
    return all
      .filter((item) => shouldShowAttention(item.priority, item.type))
      .map((item) => ({
        ...item,
        score: item.score * attentionTypeWeight(item.type),
      }))
      .sort((a, b) => b.score - a.score);
  }, [actions, events, contacts, calendar, shouldShowAttention, attentionTypeWeight]);

  const isLoading    = items === null;
  const totalCount   = items?.length ?? 0;
  const criticalCount = items?.filter((i) => i.priority === "critical").length ?? 0;
  const highCount     = items?.filter((i) => i.priority === "high").length ?? 0;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          {/* Live pulse dot for critical items */}
          {criticalCount > 0 && (
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75 animate-ping" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
            </span>
          )}

          {/* Status label */}
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            {isLoading
              ? "Checking…"
              : totalCount === 0
                ? "All clear"
                : criticalCount > 0
                  ? `${criticalCount} critical · ${totalCount} total`
                  : highCount > 0
                    ? `${highCount} high priority · ${totalCount} total`
                    : `${totalCount} item${totalCount !== 1 ? "s" : ""}`}
          </p>

          {/* Mode badge */}
          {!isDefault && (
            <span className={cn(
              "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border",
              mode.bgClass, mode.colorClass, mode.borderClass
            )}>
              <span className="h-1 w-1 rounded-full bg-current" />
              {mode.shortLabel}
            </span>
          )}
        </div>

        <button
          onClick={handleSync}
          disabled={syncing}
          className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
          aria-label="Sync integrations"
        >
          <RefreshCw className={cn("h-3 w-3", syncing && "animate-spin")} />
          {syncing ? "Syncing…" : "Sync"}
        </button>
      </div>

      {/* ── Loading skeleton ─────────────────────────────────────────────── */}
      {isLoading && (
        <div className="space-y-1.5">
          {[56, 68, 56, 68, 56].map((h, i) => (
            <div
              key={i}
              className="rounded-xl bg-card/40 border border-border/20 animate-pulse"
              style={{ height: h, opacity: 1 - i * 0.15 }}
            />
          ))}
        </div>
      )}

      {/* ── All-clear state ──────────────────────────────────────────────── */}
      {!isLoading && totalCount === 0 && (
        <div className="relative overflow-hidden rounded-xl border border-border/30 bg-card/20 px-6 py-10">
          <div
            aria-hidden
            className="absolute inset-0 pointer-events-none"
            style={{
              background: "radial-gradient(600px 250px at 50% -40%, oklch(0.72 0.15 85 / 0.05), transparent)",
            }}
          />
          <div className="relative flex flex-col items-center text-center gap-2">
            <Sparkles className="h-4 w-4 text-[oklch(0.72_0.15_85)]/40 mb-1" />
            <p className="text-sm font-medium text-foreground/60">
              Nothing requiring your attention.
            </p>
            <p className="text-[12px] text-muted-foreground/60 max-w-[320px] leading-relaxed">
              Overdue commitments, pending approvals, relationship signals, and
              upcoming meetings will surface here.
            </p>
          </div>
        </div>
      )}

      {/* ── Attention list ───────────────────────────────────────────────── */}
      {!isLoading && totalCount > 0 && (
        <div className="space-y-[3px]">
          {items!.map((item, index) => {
            const { label, Icon, labelClass } = TYPE_CONFIG[item.type];

            // Visual separation: insert a thin rule between priority tiers
            const prevItem = index > 0 ? items![index - 1] : null;
            const showTierDivider =
              prevItem &&
              prevItem.priority !== item.priority &&
              (prevItem.priority === "critical" || prevItem.priority === "high") &&
              (item.priority === "medium" || item.priority === "low");

            const rowInner = (
              <div
                className={cn(
                  "group relative overflow-hidden rounded-xl",
                  "border bg-card/50",
                  "hover:bg-card hover:border-[oklch(0.72_0.15_85)]/20",
                  "transition-all duration-150 cursor-pointer",
                  // Priority-aware border tone
                  item.priority === "critical"
                    ? "border-red-500/20"
                    : item.priority === "high"
                      ? "border-amber-400/15"
                      : "border-border/40"
                )}
              >
                {/* Left priority bar */}
                <div
                  aria-hidden
                  className={cn(
                    "absolute left-0 inset-y-0 w-[3px] rounded-l-xl",
                    PRIORITY_BAR[item.priority]
                  )}
                />

                <div className="flex items-center gap-3 pl-5 pr-4 py-3">
                  {/* Type icon */}
                  <Icon className={cn("h-3.5 w-3.5 shrink-0", labelClass)} />

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 flex-wrap min-w-0">
                      <span className={cn(
                        "text-[9.5px] font-bold uppercase tracking-[0.16em] shrink-0 leading-none",
                        labelClass
                      )}>
                        {label}
                      </span>
                      <span className="text-[13px] font-medium text-foreground/90 truncate leading-snug">
                        {item.title}
                      </span>
                    </div>
                    {item.context && (
                      <p className="text-[11px] text-muted-foreground/70 mt-0.5 truncate leading-tight">
                        {item.context}
                      </p>
                    )}
                  </div>

                  {/* Time + CTA */}
                  <div className="flex items-center gap-2.5 shrink-0 ml-1">
                    {item.timeLabel && (
                      <span className="hidden sm:block text-[11px] font-mono tabular-nums text-muted-foreground/50">
                        {item.timeLabel}
                      </span>
                    )}
                    <span className={cn(
                      "inline-flex items-center gap-1 rounded-lg px-2.5 py-1",
                      "text-[11px] font-semibold tracking-wide transition-all whitespace-nowrap",
                      "bg-muted/40 text-muted-foreground",
                      "group-hover:bg-[oklch(0.72_0.15_85)] group-hover:text-[oklch(0.15_0.04_250)]"
                    )}>
                      {item.cta}
                      <ArrowRight className="h-2.5 w-2.5" />
                    </span>
                  </div>
                </div>
              </div>
            );

            return (
              <div key={item.id}>
                {showTierDivider && (
                  <div className="flex items-center gap-3 py-2">
                    <div className="h-px flex-1 bg-border/30" />
                    <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/40 font-medium">
                      Lower priority
                    </span>
                    <div className="h-px flex-1 bg-border/30" />
                  </div>
                )}
                {item.openPanel ? (
                  <button
                    type="button"
                    onClick={() => openPanel(item.eventId)}
                    className="w-full text-left"
                  >
                    {rowInner}
                  </button>
                ) : (
                  <Link href={item.href!} className="block">
                    {rowInner}
                  </Link>
                )}
              </div>
            );
          })}

          {/* Footer link */}
          <div className="pt-2 flex justify-end">
            <Link
              href="/dashboard/actions"
              className="text-[11px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
            >
              All actions →
            </Link>
          </div>
        </div>
      )}

      {/* Approval slide-over */}
      <ApprovalPanel
        open={panelOpen}
        onClose={closePanel}
        events={events ?? []}
        focusedId={focusedId}
        onRefresh={load}
      />
    </>
  );
}
