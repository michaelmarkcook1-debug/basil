"use client";

/**
 * ModeIntelligenceBar — contextual operational signals for the active mode.
 *
 * Renders a narrow, dismissible strip below the ModeStatusBar when a
 * non-default mode is active. Each mode fetches and shows a different
 * operational signal set matched to its context.
 *
 * Design principles:
 *   - One line max on desktop; gracefully wraps on mobile
 *   - Dismissible per-session (persisted in sessionStorage)
 *   - Fetches lazily — only when mode is active
 *   - Graceful fallback if data is unavailable
 *   - Never blocks page render
 */

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  X,
  AlertCircle,
  Clock,
  Users,
  CalendarCheck,
  CheckSquare,
  Inbox,
  ArrowRight,
  BrainCircuit,
  EyeOff,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useMode } from "@/components/ui/mode-context";
import type { ModeId } from "@/lib/modes/types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function minutesUntil(iso: string): number {
  return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60_000));
}

function formatCountdown(mins: number): string {
  if (mins < 1) return "now";
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `in ${h}h ${m}m` : `in ${h}h`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n !== 1 ? "s" : ""}`;
}

// ── Intelligence skeletons ────────────────────────────────────────────────────

function IntelSkeleton() {
  return (
    <div className="flex items-center gap-3 animate-pulse">
      <div className="h-2.5 bg-current/20 rounded w-48" />
      <div className="h-2.5 bg-current/10 rounded w-32" />
    </div>
  );
}

// ── Per-mode intelligence components ─────────────────────────────────────────

function FocusModeIntel() {
  const [stats, setStats] = useState<{
    high: number;
    overdue: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/actions", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { actions?: { status: string; priority: string }[] } | null) => {
        if (!d?.actions) return;
        const actions = d.actions;
        setStats({
          // Was TWO identical filters (`critical` and `high`, both
          // priority==="high" && !done) that were then SUMMED below — so this
          // widget reported exactly double the real number of high-priority
          // items. ActionPriority is only "high" | "medium" | "low"; there is no
          // "critical" tier, so one count is the whole truth.
          high: actions.filter(
            (a) => a.priority === "high" && a.status !== "done"
          ).length,
          overdue: actions.filter((a) => a.status === "overdue").length,
        });
      })
      .catch((err) => { console.warn("[mode-intel] background fetch failed:", err); return null; })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <IntelSkeleton />;

  const totalOpen = stats ? stats.high : 0;

  return (
    <div className="flex items-center gap-3 flex-wrap text-xs">
      <span className="flex items-center gap-1.5">
        <AlertCircle className="h-3 w-3 shrink-0" />
        {stats
          ? stats.overdue > 0
            ? `${plural(stats.overdue, "overdue action")} · ${plural(totalOpen, "high-priority item")} open`
            : `${plural(totalOpen, "high-priority item")} open`
          : /* loading is already false here — claiming "Loading" would be a lie. */
            "Commitments unavailable"}
      </span>
      <Link
        href="/dashboard/actions"
        className="flex items-center gap-0.5 opacity-70 hover:opacity-100 transition-opacity"
      >
        Actions
        <ArrowRight className="h-2.5 w-2.5" />
      </Link>
    </div>
  );
}

function CoordinationModeIntel() {
  const [stats, setStats] = useState<{
    quietCount: number;
    pendingCount: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // /api/contacts does NOT exist (only its sub-routes do) — it 404'd on every
    // load, so `stats` never populated and this widget sat on the null branch
    // reading "Loading contacts…" forever. /api/contacts/all is the real route
    // and already returns exactly the { contacts } shape read below.
    fetch("/api/contacts/all", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { contacts?: { lastInteraction?: string }[] } | null) => {
        if (!d?.contacts) return;
        const now = Date.now();
        const SILENCE_THRESHOLD = 7 * 86_400_000;
        const quietCount = d.contacts.filter(
          (c) =>
            c.lastInteraction &&
            now - new Date(c.lastInteraction).getTime() > SILENCE_THRESHOLD
        ).length;
        setStats({ quietCount, pendingCount: 0 });
      })
      .catch((err) => { console.warn("[mode-intel] background fetch failed:", err); return null; })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <IntelSkeleton />;

  return (
    <div className="flex items-center gap-3 flex-wrap text-xs">
      <span className="flex items-center gap-1.5">
        <Users className="h-3 w-3 shrink-0" />
        {stats
          ? stats.quietCount > 0
            ? `${plural(stats.quietCount, "contact")} quiet this week`
            : "All key contacts active"
          : /* Not loading and still no stats ⇒ the fetch failed. Saying
               "Loading…" here would claim work is in flight that already
               finished — say what's actually true. */
            "Contact activity unavailable"}
      </span>
      <Link
        href="/dashboard/contacts"
        className="flex items-center gap-0.5 opacity-70 hover:opacity-100 transition-opacity"
      >
        Contacts
        <ArrowRight className="h-2.5 w-2.5" />
      </Link>
    </div>
  );
}

function MeetingModeIntel() {
  const [next, setNext] = useState<{
    title: string;
    start: string;
    attendeeCount: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/calendar/upcoming?limit=3", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (d: {
          events?: { title: string; start: string; attendees?: string[] }[];
        } | null) => {
          const first = d?.events?.[0];
          if (first) {
            setNext({
              title: first.title,
              start: first.start,
              attendeeCount: first.attendees?.length ?? 0,
            });
          }
        }
      )
      .catch((err) => { console.warn("[mode-intel] background fetch failed:", err); return null; })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <IntelSkeleton />;

  const mins = next ? minutesUntil(next.start) : 0;

  return (
    <div className="flex items-center gap-3 flex-wrap text-xs">
      <span className="flex items-center gap-1.5">
        <CalendarCheck className="h-3 w-3 shrink-0" />
        {next
          ? `Next: ${next.title.length > 32 ? next.title.slice(0, 29) + "…" : next.title} · ${formatCountdown(mins)}${next.attendeeCount > 0 ? ` · ${plural(next.attendeeCount, "attendee")}` : ""}`
          : "No upcoming meetings — review prep materials"}
      </span>
      <Link
        href="/dashboard/meetings"
        className="flex items-center gap-0.5 opacity-70 hover:opacity-100 transition-opacity"
      >
        Prep
        <ArrowRight className="h-2.5 w-2.5" />
      </Link>
    </div>
  );
}

function InboxRecoveryIntel() {
  const [stats, setStats] = useState<{
    total: number;
    critical: number;
    review: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/actions", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { actions?: { status: string; needsReview?: boolean; priority: string }[] } | null) => {
        if (!d?.actions) return;
        const open = d.actions.filter((a) => a.status !== "done");
        setStats({
          total: open.length,
          critical: open.filter((a) => a.priority === "high").length,
          review: open.filter((a) => a.needsReview).length,
        });
      })
      .catch((err) => { console.warn("[mode-intel] background fetch failed:", err); return null; })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <IntelSkeleton />;

  return (
    <div className="flex items-center gap-3 flex-wrap text-xs">
      <span className="flex items-center gap-1.5">
        <Inbox className="h-3 w-3 shrink-0" />
        {stats
          ? stats.total === 0
            ? "Inbox clear — nothing to process"
            : `${plural(stats.total, "item")} to process${stats.critical > 0 ? ` · ${stats.critical} high-priority` : ""}${stats.review > 0 ? ` · ${stats.review} need review` : ""}`
          : /* loading is already false here — claiming "Loading" would be a lie. */
            "Inbox unavailable"}
      </span>
      <Link
        href="/dashboard/actions"
        className="flex items-center gap-0.5 opacity-70 hover:opacity-100 transition-opacity"
      >
        Start
        <ArrowRight className="h-2.5 w-2.5" />
      </Link>
    </div>
  );
}

function DeepWorkIntel() {
  const { minutesRemaining } = useMode();

  return (
    <div className="flex items-center gap-3 flex-wrap text-xs">
      <span className="flex items-center gap-1.5">
        <EyeOff className="h-3 w-3 shrink-0" />
        All non-critical signals deferred
        {minutesRemaining !== null && (
          <span className="opacity-70">· {minutesRemaining}m remaining</span>
        )}
      </span>
      <span className="flex items-center gap-1.5 opacity-60">
        <BrainCircuit className="h-3 w-3 shrink-0" />
        Only critical blockers will interrupt
      </span>
    </div>
  );
}

function DailyBriefingIntel() {
  const [stats, setStats] = useState<{
    meetingsToday: number;
    criticalActions: number;
    overdueActions: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const today = new Date().toISOString().split("T")[0];

    Promise.all([
      fetch("/api/calendar/upcoming?limit=10", { cache: "no-store" }).then(
        (r) => (r.ok ? r.json() : null)
      ),
      fetch("/api/actions", { cache: "no-store" }).then((r) =>
        r.ok ? r.json() : null
      ),
    ])
      .then(
        ([cal, acts]: [
          { events?: { start: string }[] } | null,
          { actions?: { status: string; priority: string }[] } | null,
        ]) => {
          const meetingsToday =
            cal?.events?.filter((e) => e.start.startsWith(today)).length ?? 0;
          const openActions =
            acts?.actions?.filter((a) => a.status !== "done") ?? [];
          setStats({
            meetingsToday,
            criticalActions: openActions.filter((a) => a.priority === "high")
              .length,
            overdueActions: openActions.filter((a) => a.status === "overdue")
              .length,
          });
        }
      )
      .catch((err) => { console.warn("[mode-intel] background fetch failed:", err); return null; })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <IntelSkeleton />;

  const parts: string[] = [];
  if (stats) {
    if (stats.meetingsToday > 0)
      parts.push(plural(stats.meetingsToday, "meeting") + " today");
    if (stats.overdueActions > 0)
      parts.push(plural(stats.overdueActions, "overdue"));
    if (stats.criticalActions > 0)
      parts.push(plural(stats.criticalActions, "high-priority"));
  }

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 17) return "Good afternoon";
    return "Good evening";
  })();

  return (
    <div className="flex items-center gap-3 flex-wrap text-xs">
      <span className="flex items-center gap-1.5">
        <CheckSquare className="h-3 w-3 shrink-0" />
        {parts.length > 0
          ? `${greeting} · ${parts.join(" · ")}`
          : `${greeting} · No urgent items right now`}
      </span>
      <Link
        href="/dashboard/briefing"
        className="flex items-center gap-0.5 opacity-70 hover:opacity-100 transition-opacity"
      >
        Full briefing
        <ArrowRight className="h-2.5 w-2.5" />
      </Link>
    </div>
  );
}

// ── Mode intelligence map ─────────────────────────────────────────────────────

const INTELLIGENCE_BY_MODE: Partial<Record<ModeId, React.ReactNode>> = {
  focus:           <FocusModeIntel />,
  coordination:    <CoordinationModeIntel />,
  meeting:         <MeetingModeIntel />,
  "inbox-recovery": <InboxRecoveryIntel />,
  "deep-work":     <DeepWorkIntel />,
  "daily-briefing": <DailyBriefingIntel />,
};

const DISMISS_KEY = "basil-mode-intel-dismissed";

function getDismissedModes(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = sessionStorage.getItem(DISMISS_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function dismissMode(modeId: string): void {
  if (typeof window === "undefined") return;
  try {
    const existing = getDismissedModes();
    existing.add(modeId);
    sessionStorage.setItem(DISMISS_KEY, JSON.stringify([...existing]));
  } catch {
    // session storage unavailable
  }
}

// ── ModeIntelligenceBar ───────────────────────────────────────────────────────

export function ModeIntelligenceBar() {
  const { mode, state, isDefault } = useMode();
  const [dismissed, setDismissed] = useState(false);

  // Re-evaluate dismiss state whenever the mode changes
  useEffect(() => {
    if (isDefault) return;
    const dismissedModes = getDismissedModes();
    // Key includes activeSince so re-activating same mode shows bar again
    const key = `${state.active}:${state.activeSince ?? ""}`;
    setDismissed(dismissedModes.has(key));
  }, [state.active, state.activeSince, isDefault]);

  if (isDefault || dismissed) return null;

  const intel = INTELLIGENCE_BY_MODE[state.active];
  if (!intel) return null;

  const dismissKey = `${state.active}:${state.activeSince ?? ""}`;

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 px-4 py-2 border-b text-xs",
        mode.bgClass,
        mode.borderClass
      )}
    >
      {/* Mode-specific content */}
      <div className={cn("flex-1 min-w-0 font-medium", mode.colorClass)}>
        {intel}
      </div>

      {/* Dismiss */}
      <button
        onClick={() => {
          dismissMode(dismissKey);
          setDismissed(true);
        }}
        className="shrink-0 p-0.5 rounded opacity-40 hover:opacity-70 transition-opacity text-current"
        aria-label="Dismiss mode hint"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ── ModeFilterHint ────────────────────────────────────────────────────────────

/**
 * Compact inline hint shown when a mode is hiding items from a surface.
 * Place at the bottom of a filtered list.
 *
 * @example
 *   <ModeFilterHint hiddenCount={3} />
 */
export function ModeFilterHint({
  hiddenCount,
  className,
}: {
  hiddenCount: number;
  className?: string;
}) {
  const { mode, isDefault, state } = useMode();

  if (isDefault || hiddenCount <= 0) return null;

  return (
    <p
      className={cn(
        "flex items-center gap-1.5 text-xs text-muted-foreground/60",
        className
      )}
    >
      <EyeOff className="h-3 w-3 shrink-0" />
      {plural(hiddenCount, "item")} hidden by{" "}
      <span className={cn("font-medium", mode.colorClass)}>
        {mode.shortLabel}
      </span>
      {state.active !== "default" && (
        <span className="opacity-60">mode</span>
      )}
    </p>
  );
}
