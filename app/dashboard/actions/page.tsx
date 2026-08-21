"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useDomainSync } from "@/lib/sync/use-domain-sync";
// useDraft kept for any legacy callers; actions now uses usePersistentDraft
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { NeedsAttention } from "@/components/shared/needs-attention";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import { ContactAvatar } from "@/components/ui/contact-avatar";
import { useContactPhotos } from "@/lib/hooks/use-contact-photos";
import {
  ListChecks,
  Plus,
  Trash2,
  Check,
  Search,
  Clock,
  Link2,
  ChevronDown,
  ChevronRight,
  ShieldQuestion,
  ThumbsUp,
  X,
  Briefcase,
  ClipboardList,
  User,
  GitBranch,
  CheckSquare,
  CheckCircle2,
  RefreshCw,
  RotateCcw,
  LayoutGrid,
  Zap,
  Calendar,
  ArrowRight,
  Minus,
  Loader2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { findContactByName } from "@/lib/contacts-lookup";
import { isActionStalled } from "@/lib/actions/utils";
import { cn } from "@/lib/utils";
import { dashboardCache } from "@/lib/dashboard-cache";
import type { ActionItem, ActionCategory } from "@/lib/types/action";
import { DataState } from "@/components/ui/data-state";
import { usePersistentDraft } from "@/lib/hooks/use-persistent-draft";
import { DraftSavedIndicator } from "@/components/ui/draft-saved-indicator";
import { EvidencePanel } from "@/components/ui/trust-badge";
import { TrustReviewPrompt } from "@/components/ui/trust-ui";
import { ExplorePanel } from "@/components/explore-panel";

const LEGACY_STORAGE_KEY = "sage-actions";

interface ActionFormDraft {
  showForm: boolean;
  text: string;
  owner: string;
  due: string;
  source: ActionItem["source"];
  priority: NonNullable<ActionItem["priority"]>;
}
const ACTION_DRAFT_DEFAULT: ActionFormDraft = {
  showForm: false,
  text: "",
  owner: "",
  due: "",
  source: "manual",
  priority: "medium",
};

// ── Visual helpers ─────────────────────────────────────────────────────────────

function PriorityBadge({ priority }: { priority?: ActionItem["priority"] }) {
  if (!priority) return null;
  const styles: Record<NonNullable<ActionItem["priority"]>, string> = {
    high: "bg-signal-critical-subtle text-signal-critical border-signal-critical-border",
    medium: "bg-signal-warning-subtle text-signal-warning border-signal-warning-border",
    low: "bg-muted/50 text-muted-foreground border-border",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${styles[priority]}`}
    >
      {priority}
    </span>
  );
}

/**
 * Format a due date for display. Handles both plain "YYYY-MM-DD" dates and
 * full ISO timestamps ("2026-05-23T16:00:00Z") — never shows the raw ISO string.
 * Includes the time when the source value carried one.
 */
function formatDueDate(due: string): string {
  if (!due) return "";
  const hasTime = due.includes("T");
  const d = new Date(hasTime ? due : due + "T12:00:00");
  if (isNaN(d.getTime())) return due; // fall back to raw rather than "Invalid Date"
  const datePart = d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  if (!hasTime) return datePart;
  const timePart = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${datePart}, ${timePart}`;
}

/**
 * Badge shown when an action has a time-bounded expiresAt set.
 * Shows a countdown if expiry is within the next 4 hours; otherwise shows the time.
 * Returns null if expiresAt is in the past (action should already be archived).
 */
function ExpiryBadge({ expiresAt }: { expiresAt?: string }) {
  if (!expiresAt) return null;
  const msLeft = new Date(expiresAt).getTime() - Date.now();
  if (msLeft <= 0) return null; // already expired — listActions will archive it

  const minLeft = Math.floor(msLeft / 60_000);
  const label =
    minLeft < 60
      ? `⏱ ${minLeft}m`
      : minLeft < 240
        ? `⏱ ${Math.floor(minLeft / 60)}h ${minLeft % 60}m`
        : `⏱ expires ${new Date(expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  const urgency = minLeft < 30 ? "bg-signal-critical-subtle text-signal-critical border-signal-critical-border" : minLeft < 120 ? "bg-signal-warning-subtle text-signal-warning border-signal-warning-border" : "bg-muted/50 text-muted-foreground border-border";
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${urgency}`} title={`Expires at ${new Date(expiresAt).toLocaleString()}`}>
      {label}
    </span>
  );
}

/**
 * How sure Basil is that this commitment is real, stated in words.
 *
 * This was a 6px coloured dot with the number hidden in a `title`, which is
 * uncertainty you can only find by hovering — and on a touch screen, not at
 * all. The desk stamps its copy instead: an unconfirmed item says so on its
 * face. Extraction confidence is a REAL stored field here (unlike the today
 * feed, which carries none), so the number shown is the number recorded.
 */
function ConfidenceStamp({ confidence }: { confidence?: number }) {
  if (confidence === undefined) return null;
  const pct = Math.round(confidence * 100);
  const kind = pct >= 80 ? "confirmed" : pct >= 60 ? "developing" : "unconfirmed";
  const label = pct >= 80 ? "confirmed" : pct >= 60 ? "developing" : "unconfirmed";
  return (
    <span
      className={`wire-stamp wire-stamp-${kind}`}
      title={`Basil extracted this with ${pct}% confidence`}
    >
      {label} {pct}%
    </span>
  );
}

function SourceBadge({ source }: { source: ActionItem["source"] }) {
  const styles: Record<ActionItem["source"], string> = {
    meeting: "bg-signal-info-subtle text-signal-info",
    slack:   "bg-signal-positive-subtle text-signal-positive",
    teams:   "bg-muted/50 text-muted-foreground",
    email:   "bg-signal-info-subtle text-signal-info",
    manual:  "bg-muted/50 text-muted-foreground",
    // Was bg-indigo-100/text-indigo-700 — a light-theme leftover that read as an
    // unreadable pale chip on the dark theme. Ask-Basil-sourced items now use the
    // app's own assistant accent (gold), consistent with the sidebar/chat UI.
    chat:    "bg-[var(--w-carbon-tint)] text-[var(--w-carbon)]",
    linear:  "bg-signal-info-subtle text-signal-info",
  };
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${styles[source]}`}
    >
      {source}
    </span>
  );
}

/** Amber pill shown on actions that need user confirmation before being trusted. */
function NeedsReviewBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-signal-warning-border bg-signal-warning-subtle px-2 py-0.5 text-xs font-medium text-signal-warning">
      <ShieldQuestion className="h-2.5 w-2.5" />
      Review
    </span>
  );
}

/** Compact category chip. */
function CategoryChip({ category }: { category?: ActionCategory }) {
  if (!category) return null;
  const styles: Record<ActionCategory, { cls: string; label: string; Icon: React.ComponentType<{ className?: string }> }> = {
    critical: { cls: "bg-signal-critical-subtle text-signal-critical border-signal-critical-border",    label: "Critical", Icon: Briefcase },
    admin:    { cls: "bg-signal-info-subtle  text-signal-info  border-signal-info-border",   label: "Admin",    Icon: ClipboardList },
    personal: { cls: "bg-signal-positive-subtle text-signal-positive border-signal-positive-border", label: "Personal", Icon: User },
  };
  const { cls, label, Icon } = styles[category];
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs font-medium ${cls}`}>
      <Icon className="h-2.5 w-2.5" />
      {label}
    </span>
  );
}

/** Decision-required pill — click navigates to Decisions page. */
function DecisionRequiredBadge({ onClick }: { onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-full border border-signal-info-border bg-signal-info-subtle px-2 py-0.5 text-xs font-medium text-signal-info hover:bg-signal-info-subtle transition-colors cursor-pointer"
      title="A decision needs to be made — click to log it"
    >
      <GitBranch className="h-2.5 w-2.5" />
      Decision needed
    </button>
  );
}

// ── Section headings ───────────────────────────────────────────────────────────

function SectionHeading({
  label,
  count,
  accent,
}: {
  label: string;
  count: number;
  accent?: string;
}) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <span className={`text-xs font-semibold uppercase tracking-wider ${accent ?? "text-muted-foreground"}`}>
        {label}
      </span>
      <span className="text-xs text-muted-foreground">({count})</span>
      <div className="flex-1 border-t border-border/50" />
    </div>
  );
}

// ── Action card ────────────────────────────────────────────────────────────────

function ActionCard({
  action,
  onToggle,
  onDelete,
  onConfirmReview,
  onDecisionClick,
  onNotes,
  todayStr,
  photos = {},
}: {
  action: ActionItem;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onConfirmReview?: (id: string) => void;
  onDecisionClick?: (action: ActionItem) => void;
  onNotes?: (id: string, notes: string) => Promise<void>;
  todayStr: string;
  photos?: Record<string, string>;
}) {
  // No local confirmation state — delete is single-click with a 5 s undo toast.
  const contact = findContactByName(action.owner);
  const isOverdue =
    action.status === "overdue" ||
    (action.status === "open" && action.dueDate && action.dueDate < todayStr);
  const isDueToday = action.status === "open" && action.dueDate === todayStr;
  const stalled = isActionStalled(action);

  return (
    // A filed commitment, not a card. Rows share one rule so the queue stays
    // dense enough to work down; a stack of cards spends most of its height on
    // its own edges. Done items stay legible rather than dimmed to 55% — a
    // completed commitment is evidence you acted, and this app has a standing
    // problem with outbound work being invisible.
    <article
      className={`wire-dispatch !grid-cols-[auto_minmax(0,1fr)] ${
        action.status === "done" ? "opacity-80" : ""
      }`}
    >
      <div className="contents">
        {/* Checkbox */}
        <button
          onClick={() => onToggle(action.id)}
          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors ${
            action.status === "done"
              ? "bg-signal-positive border-signal-positive text-white"
              : "border-border hover:border-[var(--w-carbon)]"
          }`}
        >
          {action.status === "done" && <Check className="h-3 w-3" />}
        </button>

        {/* Body */}
        <div className="flex-1 min-w-0">
          <p
            className={`text-sm leading-snug ${
              action.status === "done" ? "line-through text-muted-foreground" : ""
            }`}
          >
            {action.text}
          </p>

          {/* Meta row */}
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            {/* Resolution marker. Signal-driven closes (you accepted an invite /
                sent a reply) read as what you DID; lifecycle sweeps read as
                auto-archived. Neither is conflated with a manual completion. */}
            {action.archivedReason && (() => {
              const signalDriven = action.archivedReason === "rsvp-confirmed" || action.archivedReason === "reply-sent";
              const label =
                action.archivedReason === "rsvp-confirmed" ? "you responded on your calendar"
                : action.archivedReason === "reply-sent" ? "you replied"
                : action.archivedReason === "stale-overdue" ? "expired overdue"
                : action.archivedReason === "past-meeting" ? "meeting passed"
                : "time-boxed";
              return (
                <span className={cn(
                  "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                  signalDriven
                    ? "border-signal-positive-border bg-signal-positive-subtle text-signal-positive"
                    : "border-border bg-muted/40 text-muted-foreground"
                )}>
                  {signalDriven ? "" : "Auto-archived · "}{label}
                </span>
              );
            })()}
            {/* Owner */}
            <div className="flex items-center gap-1.5">
              {contact && (
                <ContactAvatar
                  initials={contact.initials}
                  color={contact.color}
                  photoUrl={photos[contact.email?.toLowerCase() ?? ""]}
                  className="h-4 w-4"
                  fallbackClassName="text-xs"
                />
              )}
              <span className="text-xs text-muted-foreground">{action.owner}</span>
            </div>

            {/* Due date */}
            {action.dueDate && (
              <span
                className={`text-xs font-medium ${
                  isOverdue
                    ? "text-signal-critical"
                    : isDueToday
                    ? "text-signal-warning"
                    : "text-muted-foreground"
                }`}
              >
                Due {formatDueDate(action.dueDate)}
              </span>
            )}

            {/* Stalled indicator */}
            {stalled && (
              <span className="inline-flex items-center gap-1 text-xs text-signal-warning font-medium">
                <Clock className="h-3 w-3" />
                Stalled
              </span>
            )}

            <ExpiryBadge expiresAt={action.expiresAt} />
            <PriorityBadge priority={action.priority} />
            <SourceBadge source={action.source} />
            <CategoryChip category={action.category} />
            <ConfidenceStamp confidence={action.confidence} />
            {action.needsReview && <NeedsReviewBadge />}

            {/* Decision needed — click-through to Decisions */}
            {action.decisionRequired && !action.linkedDecisionId && (
              <DecisionRequiredBadge onClick={() => onDecisionClick?.(action)} />
            )}

            {/* Linked decisions */}
            {action.linkedDecisionIds && action.linkedDecisionIds.length > 0 && (
              <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
                <Link2 className="h-3 w-3" />
                {action.linkedDecisionIds.length}
              </span>
            )}
          </div>

          {/* Evidence panel — "Why am I seeing this?" */}
          {(action.sourceRef || action.additionalSourceRefs?.length || action.confidence !== undefined) && (
            <EvidencePanel
              sourceRef={action.sourceRef}
              additionalSourceRefs={action.additionalSourceRefs}
              confidence={action.confidence}
              context={action.source !== "manual" ? action.source : undefined}
            />
          )}

          {/* Review prompt — confirm keeps it, dismiss removes it */}
          {action.needsReview && (
            <TrustReviewPrompt
              artifactType="action"
              onConfirm={() => onConfirmReview?.(action.id)}
              onDismiss={() => onDelete(action.id)}
              className="mt-2"
            />
          )}

          {/* Explore further — inline notes */}
          {onNotes && action.status !== "done" && (
            <ExplorePanel
              notes={action.notes}
              onSave={(notes) => onNotes(action.id, notes)}
            />
          )}
        </div>

        {/* Delete — single click, undo toast gives 5 s to recover */}
        <button
          onClick={() => onDelete(action.id)}
          className="text-muted-foreground/50 hover:text-destructive transition-colors shrink-0"
          title="Delete action"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </article>
  );
}

// ── Collapsible section wrapper ────────────────────────────────────────────────

function CollapsibleSection({
  label,
  accent,
  items,
  note,
  archive = false,
  defaultOpen = true,
  onToggle,
  onDelete,
  onConfirmReview,
  onDecisionClick,
  onNotes,
  todayStr,
  photos = {},
}: {
  label: string;
  accent?: string;
  items: ActionItem[];
  /** One line explaining what this group IS, shown when opened. */
  note?: string;
  /**
   * Archive treatment: sunk ground, quieter rule, smaller heading. Used for
   * material that is filed rather than pending. Without it, 348 stalled rows
   * and 200 completed ones carry the same visual weight as the four things
   * actually due today, which is the whole reason the page felt like a database.
   */
  archive?: boolean;
  defaultOpen?: boolean;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onConfirmReview?: (id: string) => void;
  onDecisionClick?: (action: ActionItem) => void;
  onNotes?: (id: string, notes: string) => Promise<void>;
  todayStr: string;
  photos?: Record<string, string>;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (items.length === 0) return null;

  return (
    <div className={archive ? "mt-6 rounded-lg border border-[var(--w-rule)] bg-[var(--w-tray)] p-3" : ""}>
      {archive && (
        <p className="mb-1.5 text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-[var(--w-ink-soft)]">
          Archive
        </p>
      )}
      <button
        className="flex items-center gap-2 w-full mb-2 group min-h-[44px] sm:min-h-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        )}
        <span className={`text-[0.8125rem] font-semibold ${accent ?? "text-[var(--w-ink)]"}`}>
          {label}
        </span>
        <span className="wire-data text-xs text-muted-foreground">({items.length})</span>
        <div className="flex-1 border-t border-border/50" />
      </button>
      {open && note && (
        <p className="mb-2 text-[0.8125rem] text-[var(--w-ink-soft)]">{note}</p>
      )}
      {open && (
        <div className="space-y-2">
          {items.map((a) => (
            <ActionCard
              key={a.id}
              action={a}
              onToggle={onToggle}
              onDelete={onDelete}
              onConfirmReview={onConfirmReview}
              onDecisionClick={onDecisionClick}
              onNotes={onNotes}
              todayStr={todayStr}
              photos={photos}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Priority sort order ────────────────────────────────────────────────────────

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

function sortByPriority(a: ActionItem, b: ActionItem): number {
  const pa = PRIORITY_ORDER[a.priority ?? "low"] ?? 2;
  const pb = PRIORITY_ORDER[b.priority ?? "low"] ?? 2;
  if (pa !== pb) return pa - pb;
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}

function ActionsSyncButton({ onSynced }: { onSynced?: () => void }) {
  const [syncing, setSyncing] = useState(false);
  const [done, setDone] = useState(false);
  return (
    <button
      disabled={syncing}
      onClick={async () => {
        setSyncing(true);
        try { await fetch("/api/events/poll-ingest", { method: "POST" }); } catch { /* ignore */ }
        setSyncing(false);
        setDone(true);
        onSynced?.();
        // Background materialization runs server-side after poll-ingest returns.
        // A second refresh ~12 s later catches actions written by the after() blocks.
        setTimeout(() => { onSynced?.(); }, 12_000);
        setTimeout(() => setDone(false), 20_000);
      }}
      className="inline-flex items-center gap-2 text-sm text-[var(--w-carbon)] hover:underline disabled:opacity-50"
    >
      <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
      {done ? "Syncing in background…" : syncing ? "Syncing…" : "Sync recent activity"}
    </button>
  );
}

// ── Completed actions sidebar ─────────────────────────────────────────────────

function CompletedActionsPanel({ items, todayStr }: { items: ActionItem[]; todayStr: string }) {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().split("T")[0];

  // Group by completion date (updatedAt), most recent first
  const grouped = new Map<string, ActionItem[]>();
  for (const a of [...items].sort(
    (x, y) => new Date(y.updatedAt).getTime() - new Date(x.updatedAt).getTime()
  )) {
    const key = a.updatedAt.split("T")[0];
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(a);
  }
  const dates = Array.from(grouped.keys());

  function dateLabel(d: string) {
    if (d === todayStr) return "Today";
    if (d === yesterday) return "Yesterday";
    return new Date(d + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }

  if (dates.length === 0) return null;

  return (
    <div className="sticky top-4 space-y-3">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 text-signal-positive" />
        <span className="text-sm font-semibold">Completed</span>
        <span className="text-xs text-muted-foreground">({items.length})</span>
      </div>
      <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
        {dates.map((date) => (
          <div key={date}>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
              {dateLabel(date)}
            </p>
            <div>
              {grouped.get(date)!.map((a) => (
                <div
                  key={a.id}
                  className="flex items-start gap-2 py-1.5 border-b border-border/30 last:border-0"
                >
                  <Check className="h-3 w-3 text-signal-positive mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-muted-foreground leading-snug line-clamp-2">{a.text}</p>
                    {a.owner && (
                      <p className="text-xs text-muted-foreground/60 mt-0.5">{a.owner}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Eisenhower Matrix view ─────────────────────────────────────────────────────

type EisenhowerQuadrant = "Q1" | "Q2" | "Q3" | "Q4";

const QUADRANTS: Array<{
  id: EisenhowerQuadrant;
  label: string;
  sublabel: string;
  verb: string;
  urgent: boolean;
  important: boolean;
  bg: string;
  border: string;
  headerBg: string;
  headerText: string;
  badgeBg: string;
  Icon: React.ComponentType<{ className?: string }>;
}> = [
  {
    id: "Q1",
    label: "Do First",
    sublabel: "Urgent + Important",
    verb: "DO",
    urgent: true,
    important: true,
    bg: "bg-signal-critical/[0.03]",
    border: "border-signal-critical-border/30",
    headerBg: "bg-signal-critical/[0.07]",
    headerText: "text-signal-critical",
    badgeBg: "bg-signal-critical-subtle text-signal-critical",
    Icon: Zap,
  },
  {
    id: "Q2",
    label: "Schedule",
    sublabel: "Not Urgent + Important",
    verb: "PLAN",
    urgent: false,
    important: true,
    bg: "bg-signal-positive/[0.03]",
    border: "border-signal-positive-border/30",
    headerBg: "bg-signal-positive/[0.07]",
    headerText: "text-signal-positive",
    badgeBg: "bg-signal-positive-subtle text-signal-positive",
    Icon: Calendar,
  },
  {
    id: "Q3",
    label: "Delegate",
    sublabel: "Urgent + Not Important",
    verb: "DELEGATE",
    urgent: true,
    important: false,
    bg: "bg-signal-warning/[0.03]",
    border: "border-signal-warning-border/30",
    headerBg: "bg-signal-warning/[0.07]",
    headerText: "text-signal-warning",
    badgeBg: "bg-signal-warning-subtle text-signal-warning",
    Icon: ArrowRight,
  },
  {
    id: "Q4",
    label: "Eliminate",
    sublabel: "Not Urgent + Not Important",
    verb: "DROP",
    urgent: false,
    important: false,
    bg: "bg-slate-500/[0.03]",
    border: "border-slate-300/40",
    headerBg: "bg-muted/40",
    headerText: "text-muted-foreground",
    badgeBg: "bg-muted/40 text-muted-foreground",
    Icon: Minus,
  },
];

/** Compact action row inside a matrix quadrant */
function MatrixActionRow({
  action,
  onToggle,
  onDelete,
  onNotes,
  todayStr,
}: {
  action: ActionItem;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onNotes?: (id: string, notes: string) => Promise<void>;
  todayStr: string;
}) {
  const isOverdue = action.dueDate && action.dueDate < todayStr && action.status !== "done";
  return (
    <div className="flex items-start gap-2 py-2 border-b border-border/25 last:border-0 group">
      <button
        onClick={() => onToggle(action.id)}
        className="mt-0.5 shrink-0 h-4 w-4 rounded border border-border/60 flex items-center justify-center hover:border-signal-positive transition-colors"
        title="Mark done"
      >
        {action.status === "done" && <Check className="h-2.5 w-2.5 text-signal-positive" />}
      </button>
      <div className="flex-1 min-w-0">
        {/* Action text — lifted from text-[12px] to text-sm so the matrix view
            matches body readability across the rest of the app. Foreground at
            full opacity (instead of /85) keeps the row scannable from a glance. */}
        <p className={`text-sm leading-snug ${action.status === "done" ? "line-through text-muted-foreground/70" : "text-foreground"}`}>
          {action.text}
        </p>
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          <ExpiryBadge expiresAt={action.expiresAt} />
          {action.dueDate && (
            <span className={`text-xs font-medium ${isOverdue ? "text-signal-critical" : "text-muted-foreground"}`}>
              {isOverdue ? "⚠ " : ""}{formatDueDate(action.dueDate)}
            </span>
          )}
          {action.owner && action.owner.toLowerCase() !== "me" && (
            <span className="text-xs text-muted-foreground">→ {action.owner}</span>
          )}
          {action.eisenhowerReason && (
            // Lifted from text-xs / opacity 40 (illegible) to text-xs / 80.
            <span className="text-xs text-muted-foreground/80 italic">{action.eisenhowerReason}</span>
          )}
        </div>
        {onNotes && action.status !== "done" && (
          <ExplorePanel
            notes={action.notes}
            onSave={(notes) => onNotes(action.id, notes)}
            className="mt-1"
          />
        )}
      </div>
      <button
        onClick={() => onDelete(action.id)}
        className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-0.5 hover:text-signal-critical"
        title="Delete"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}

function MatrixView({
  actions,
  classifying,
  classifyStatus,
  onClassify,
  onToggle,
  onDelete,
  onNotes,
  todayStr,
}: {
  actions: ActionItem[];
  classifying: boolean;
  classifyStatus: { type: "error" | "warning" | "success"; message: string } | null;
  onClassify: () => void;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onNotes?: (id: string, notes: string) => Promise<void>;
  todayStr: string;
}) {
  const open = actions.filter((a) => a.status !== "done");
  const byQuadrant = (q: EisenhowerQuadrant) => open.filter((a) => a.eisenhower === q);
  const unclassified = open.filter((a) => !a.eisenhower);
  const classifiedCount = open.filter((a) => !!a.eisenhower).length;

  return (
    <div className="space-y-4">
      {/* Axis labels + classify button */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-4 text-xs text-muted-foreground/60 font-medium">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-signal-critical inline-block" /> Urgent
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-signal-positive inline-block" /> Important
          </span>
          {classifiedCount > 0 && (
            <span className="text-muted-foreground/40">{classifiedCount}/{open.length} classified</span>
          )}
        </div>
        <button
          onClick={onClassify}
          disabled={classifying || open.length === 0}
          className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-[var(--w-carbon-tint)] text-[var(--w-carbon)] hover:bg-[var(--w-carbon-tint)] border border-[var(--w-rule)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {classifying ? (
            <><Loader2 className="h-3 w-3 animate-spin" />Classifying…</>
          ) : (
            <><Zap className="h-3 w-3" />{classifiedCount > 0 ? "Re-classify" : "Classify with Basil"}</>
          )}
        </button>
      </div>

      {/* Status banner — error or heuristic-fallback notice */}
      {classifyStatus && (
        <div className={`flex items-start gap-2 rounded-lg px-3 py-2.5 text-[12px] ${
          classifyStatus.type === "error"
            ? "bg-signal-critical-subtle border border-signal-critical-border text-signal-critical"
            : classifyStatus.type === "warning"
              ? "bg-signal-warning-subtle border border-signal-warning-border text-signal-warning"
              : "bg-signal-positive-subtle border border-signal-positive-border text-signal-positive"
        }`}>
          <span>{classifyStatus.type === "error" ? "⚠ " : classifyStatus.type === "warning" ? "ℹ " : "✓ "}</span>
          <span>{classifyStatus.message}</span>
          {classifyStatus.type === "error" && (
            <a href="/dashboard/settings?tab=brain" className="ml-auto font-semibold underline shrink-0">
              Configure brain →
            </a>
          )}
        </div>
      )}

      {/* The 2×2 grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {QUADRANTS.map((q) => {
          const items = byQuadrant(q.id);
          const Icon = q.Icon;
          return (
            <div
              key={q.id}
              className={`rounded-xl border ${q.border} ${q.bg} overflow-hidden`}
            >
              {/* Quadrant header */}
              <div className={`px-4 py-3 ${q.headerBg} flex items-center justify-between`}>
                <div className="flex items-center gap-2.5">
                  <Icon className={`h-4 w-4 ${q.headerText}`} />
                  {/* Lifted verb from text-xs → text-xs, sublabel from
                      opacity-60 → text-muted-foreground for readability. */}
                  <span className={`text-xs font-bold uppercase tracking-wider ${q.headerText}`}>
                    {q.verb}
                  </span>
                  <span className="text-xs text-muted-foreground">{q.sublabel}</span>
                </div>
                {items.length > 0 && (
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${q.badgeBg}`}>
                    {items.length}
                  </span>
                )}
              </div>
              {/* Items */}
              <div className="px-4 py-1 min-h-[80px]">
                {items.length === 0 ? (
                  <p className="text-xs text-muted-foreground/60 py-3 italic">
                    {classifiedCount === 0 ? "Run classify to populate" : "Nothing here"}
                  </p>
                ) : (
                  items.map((a) => (
                    <MatrixActionRow
                      key={a.id}
                      action={a}
                      onToggle={onToggle}
                      onDelete={onDelete}
                      onNotes={onNotes}
                      todayStr={todayStr}
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Unclassified overflow */}
      {unclassified.length > 0 && (
        <div className="rounded-xl border border-border/30 bg-muted/20 overflow-hidden">
          <div className="px-4 py-3 bg-muted/30 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Unclassified
            </span>
            <span className="text-xs text-muted-foreground/80">{unclassified.length} item{unclassified.length !== 1 ? "s" : ""} · run classify to sort</span>
          </div>
          <div className="px-4 py-1">
            {unclassified.map((a) => (
              <MatrixActionRow
                key={a.id}
                action={a}
                onToggle={onToggle}
                onDelete={onDelete}
                todayStr={todayStr}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function ActionsPage() {
  const router = useRouter();
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<Error | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  // "timeline" (default) | "category" | "matrix" view
  const [viewMode, setViewMode] = useState<"timeline" | "category" | "matrix">("timeline");

  // Sync filter + view from URL params on mount (?filter=overdue, ?view=matrix)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const p = new URLSearchParams(window.location.search);
    const f = p.get("filter");
    if (f) setStatusFilter(f);
    const v = p.get("view") as "timeline" | "category" | "matrix" | null;
    if (v && ["timeline", "category", "matrix"].includes(v)) setViewMode(v);
  }, []);
  const [classifying, setClassifying] = useState(false);
  const [classifyStatus, setClassifyStatus] = useState<{ type: "error" | "warning" | "success"; message: string } | null>(null);
  // Form draft — survives tab switches; cleared on save or explicit cancel.
  const { draft: form, setDraft: setForm, clearDraft: clearForm, draftSaved: formDraftSaved } =
    usePersistentDraft<ActionFormDraft>("draft-action", { defaultValue: ACTION_DRAFT_DEFAULT });
  const migratedRef = useRef(false);

  // ?new=1 — the Cmd-K palette's "New action" quick action. The palette
  // advertised this param but nothing read it, so the shortcut navigated here
  // and silently did nothing. (Separate effect from the filter/view sync above
  // because setForm comes from the persistent-draft hook declared just above.)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const p = new URLSearchParams(window.location.search);
    if (p.get("new") === "1") {
      setForm((f) => ({ ...f, showForm: true }));
      const clean = new URL(window.location.href);
      clean.searchParams.delete("new");
      window.history.replaceState(null, "", clean.toString());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Undo system ────────────────────────────────────────────────────────────
  const undoTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [undoEntry, setUndoEntry] = useState<{
    label: string;
    restore: () => Promise<void>;
  } | null>(null);

  function pushUndo(entry: { label: string; restore: () => Promise<void> }) {
    if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current);
    setUndoEntry(entry);
    undoTimeoutRef.current = setTimeout(() => {
      setUndoEntry(null);
      undoTimeoutRef.current = null;
    }, 5000);
  }

  async function handleUndo() {
    if (!undoEntry) return;
    if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current);
    setUndoEntry(null);
    await undoEntry.restore();
    notify();
    await refresh();
  }

  function handleDecisionClick(action: ActionItem) {
    // Navigate to Decisions page with action context pre-filled as a query param
    const params = new URLSearchParams({
      fromAction: action.id,
      text: action.text.slice(0, 200),
    });
    router.push(`/dashboard/decisions?${params.toString()}`);
  }

  const refresh = useCallback(async () => {
    // Serve cached data instantly — eliminates blank flash on tab switch
    const cached = dashboardCache.get<ActionItem[]>("actions");
    if (cached) { setActions(cached); setLoading(false); }
    // Always revalidate from server
    try {
      const res = await fetch("/api/actions", { cache: "no-store" });
      if (!res.ok) {
        console.error("[basil-fetch]", res.status === 401 ? "auth_error" : "server_error", { route: "/api/actions", status: res.status, component: "ActionsPage" });
        if (!cached) setFetchError(new Error(`HTTP ${res.status}`));
        setLoading(false);
        return;
      }
      setFetchError(null);
      const data = await res.json() as { actions?: ActionItem[] };
      const fresh: ActionItem[] = data.actions ?? [];
      dashboardCache.set("actions", fresh);
      setActions(fresh);
    } catch (e) {
      console.error("[basil-fetch] network_error", { route: "/api/actions", component: "ActionsPage", error: e instanceof Error ? e.message : String(e) });
      if (!cached) setFetchError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoading(false);
    }
  }, []);

  const notify = useDomainSync("actions", refresh);

  useEffect(() => {
    (async () => {
      if (!migratedRef.current && typeof window !== "undefined") {
        migratedRef.current = true;
        try {
          const raw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
          if (raw) {
            const parsed = JSON.parse(raw) as ActionItem[];
            if (Array.isArray(parsed) && parsed.length > 0) {
              const res = await fetch("/api/actions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ import: parsed }),
              });
              // fetch() does NOT reject on 5xx. Without this check the
              // removeItem below ran even when the import had failed, so a
              // server error PERMANENTLY DESTROYED every legacy action — the
              // only copy. Keep the local copy unless the server confirmed it.
              if (!res.ok) {
                throw new Error(`legacy action import failed (${res.status})`);
              }
            }
            window.localStorage.removeItem(LEGACY_STORAGE_KEY);
          }
        } catch {
          /* API is authoritative */
        }
      }
      await refresh();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Periodic auto-refresh — background materialization (email/Slack classify → createAction)
  // runs server-side after poll-ingest returns; domain-emit can only fire from the browser
  // (BroadcastChannel). If the user is on this page rather than the main dashboard where
  // BasilWatching triggers emits, new actions would never appear without this interval.
  useEffect(() => {
    const interval = setInterval(() => { void refresh(); }, 120_000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Reload when the tab regains focus — keeps data in sync across multiple open tabs
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  async function handleAdd() {
    if (!form.text.trim()) return;
    try {
      const res = await fetch("/api/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: form.text,
          owner: form.owner || undefined,
          ownerId: findContactByName(form.owner)?.id,
          dueDate: form.due || undefined,
          source: form.source,
          priority: form.priority,
        }),
      });
      if (!res.ok) throw new Error(`Save failed: ${res.status}`);
      clearForm();
      notify();
      await refresh();
    } catch (err) {
      console.error("[actions] handleAdd failed:", err);
      // Keep form text so user doesn't lose their input
    }
  }

  async function toggleDone(id: string) {
    const current = actions.find((a) => a.id === id);
    if (!current) return;
    const prevStatus = current.status;
    const next = current.status === "done" ? "open" : "done";

    // Optimistic update — bust cache before notify()/refresh() re-renders from it
    const patched = actions.map((a) =>
      a.id === id ? { ...a, status: next as typeof a.status } : a
    );
    setActions(patched);
    dashboardCache.set("actions", patched);

    // Offer undo when marking done
    if (next === "done") {
      pushUndo({
        label: `"${current.text.slice(0, 45)}" marked done`,
        restore: async () => {
          await fetch(`/api/actions/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: prevStatus }),
          });
        },
      });
    }

    await fetch(`/api/actions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    notify();
    await refresh();
  }

  async function handleDelete(id: string) {
    const target = actions.find((a) => a.id === id);

    // Optimistic: remove from UI and cache immediately — no flash / accidental restore
    setActions((prev) => {
      const next = prev.filter((a) => a.id !== id);
      dashboardCache.set("actions", next);
      return next;
    });

    // Allow undo for 5 s before the delete is permanent
    if (target) {
      pushUndo({
        label: `"${target.text.slice(0, 45)}" deleted`,
        restore: async () => {
          // Restore optimistically in UI first
          setActions((prev) => {
            const next = [target, ...prev];
            dashboardCache.set("actions", next);
            return next;
          });
          // Re-create via API (new ID, but all content preserved)
          await fetch("/api/actions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text:     target.text,
              owner:    target.owner,
              ownerId:  (target as ActionItem & { ownerId?: string }).ownerId,
              dueDate:  target.dueDate,
              source:   target.source,
              priority: target.priority,
              status:   target.status === "done" ? "open" : target.status,
            }),
          });
        },
      });
    }

    await fetch(`/api/actions/${id}`, { method: "DELETE" });
    // Background sync to other tabs
    notify();
  }

  async function handleConfirmReview(id: string) {
    await fetch(`/api/actions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        needsReview: false,
        reviewDismissedAt: new Date().toISOString(),
      }),
    });
    notify();
    await refresh();
  }

  async function handleNotes(id: string, notes: string) {
    // Optimistic update — reflect notes immediately in local state and cache
    const patched = actions.map((a) => (a.id === id ? { ...a, notes } : a));
    setActions(patched);
    dashboardCache.set("actions", patched);

    await fetch(`/api/actions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes }),
    });
  }

  async function handleClassify() {
    setClassifying(true);
    setClassifyStatus(null);
    try {
      const res = await fetch("/api/actions/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      const data = await res.json().catch(() => ({})) as {
        classified?: Array<unknown>;
        method?: string;
        warning?: string;
        error?: string;
      };
      if (!res.ok) {
        setClassifyStatus({
          type: "error",
          message: data.error ?? `Classification failed (${res.status}). Check your AI brain configuration.`,
        });
        return;
      }
      if (data.method === "heuristic") {
        setClassifyStatus({
          type: "warning",
          message: "AI brain offline — classified using rules (priority + due date). Results will improve when brain is back.",
        });
      } else if (data.classified && data.classified.length > 0) {
        setClassifyStatus({
          type: "success",
          message: `Classified ${data.classified.length} action${data.classified.length !== 1 ? "s" : ""} with AI.`,
        });
      }
      // The classify route returns the fully-updated actions list read directly
      // from Blob after all writes commit — use it to update state immediately.
      // This avoids a separate round-trip and eliminates the cross-instance CDN
      // race where a second ?fresh=true fetch could hit a Fluid Compute instance
      // with a stale /tmp cache or stale CDN content.
      const returnedActions = (data as { actions?: ActionItem[] }).actions;
      if (Array.isArray(returnedActions) && returnedActions.length > 0) {
        dashboardCache.set("actions", returnedActions);
        setActions(returnedActions);
        setFetchError(null);
      } else {
        // Fallback: classify route on an older deployment without `actions` field
        try {
          const freshRes = await fetch("/api/actions?fresh=true", { cache: "no-store" });
          if (freshRes.ok) {
            const freshData = await freshRes.json() as { actions?: ActionItem[] };
            const fresh = freshData.actions ?? [];
            dashboardCache.set("actions", fresh);
            setActions(fresh);
            setFetchError(null);
          } else {
            await refresh();
          }
        } catch {
          await refresh();
        }
      }
    } catch (e) {
      console.error("[classify] failed:", e);
      setClassifyStatus({ type: "error", message: "Network error — could not reach classify endpoint." });
    } finally {
      setClassifying(false);
    }
  }

  const todayStr = new Date().toISOString().split("T")[0];

  // Batch-fetch headshots for all action owners that map to known contacts
  const ownerEmails = useMemo(() => {
    const emails: string[] = [];
    for (const a of actions) {
      const c = findContactByName(a.owner);
      if (c?.email) emails.push(c.email.toLowerCase());
    }
    return Array.from(new Set(emails));
  }, [actions]);
  const photos = useContactPhotos(ownerEmails);

  // ── Filter ─────────────────────────────────────────────────────────────────
  const filtered = actions.filter((a) => {
    const matchesSearch =
      !search ||
      a.text.toLowerCase().includes(search.toLowerCase()) ||
      a.owner.toLowerCase().includes(search.toLowerCase());
    if (statusFilter === "review") return matchesSearch && !!a.needsReview;
    const matchesStatus = statusFilter === "all" || a.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  // ── Grouping ───────────────────────────────────────────────────────────────
  const overdue = filtered
    .filter(
      (a) =>
        (a.status === "overdue" ||
          (a.status === "open" && a.dueDate && a.dueDate < todayStr)) &&
        !isActionStalled(a)
    )
    .sort(sortByPriority);

  const dueToday = filtered
    .filter((a) => a.status === "open" && a.dueDate === todayStr)
    .sort(sortByPriority);

  const upcoming = filtered
    .filter(
      (a) =>
        a.status === "open" &&
        a.dueDate &&
        a.dueDate > todayStr &&
        !isActionStalled(a)
    )
    .sort((a, b) => {
      if (a.dueDate! < b.dueDate!) return -1;
      if (a.dueDate! > b.dueDate!) return 1;
      return sortByPriority(a, b);
    });

  const openNoDue = filtered
    .filter(
      (a) => a.status === "open" && !a.dueDate && !isActionStalled(a)
    )
    .sort(sortByPriority);

  const stalled = filtered.filter((a) => isActionStalled(a)).sort(sortByPriority);

  const done = filtered.filter((a) => a.status === "done").sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );

  const reviewItems = actions.filter((a) => !!a.needsReview);
  const openCount = overdue.length + dueToday.length + upcoming.length + openNoDue.length + stalled.length;
  const showGrouped = statusFilter === "all" || statusFilter === "open" || statusFilter === "overdue" || statusFilter === "review";

  // ── Category grouping (for "By Category" view) ─────────────────────────────
  const openActions = filtered.filter((a) => a.status !== "done");
  const critical = openActions.filter((a) => a.category === "critical").sort(sortByPriority);
  const adminActs = openActions.filter((a) => a.category === "admin").sort(sortByPriority);
  const personal  = openActions.filter((a) => a.category === "personal").sort(sortByPriority);
  const uncategorized = openActions.filter((a) => !a.category).sort(sortByPriority);
  const decisionNeeded = openActions.filter((a) => a.decisionRequired && !a.linkedDecisionId).sort(sortByPriority);

  return (
    // The Wire Desk (seed basil01). `wire` scopes the world to this surface so
    // pages not yet converted keep the incumbent one and never render half-broken.
    <div className="wire p-4 sm:p-6 lg:p-8 space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="wire-slug text-2xl tracking-tight flex items-center gap-2 text-[var(--w-ink)]">
            <ListChecks className="h-6 w-6 text-[var(--w-carbon)]" />
            Commitments
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Commitments from meetings, Slack, and email. Basil can read and add to this list.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* View mode toggle */}
          <div className="hidden sm:flex rounded-lg border border-border overflow-hidden text-xs">
            <button
              className={`px-3 py-1.5 font-medium transition-colors ${viewMode === "timeline" ? "bg-[var(--w-carbon)] text-white" : "bg-background text-muted-foreground hover:text-foreground"}`}
              onClick={() => setViewMode("timeline")}
            >Timeline</button>
            <button
              className={`px-3 py-1.5 font-medium transition-colors ${viewMode === "category" ? "bg-[var(--w-carbon)] text-white" : "bg-background text-muted-foreground hover:text-foreground"}`}
              onClick={() => setViewMode("category")}
            >By Category</button>
            <button
              className={`px-3 py-1.5 font-medium transition-colors flex items-center gap-1 ${viewMode === "matrix" ? "bg-[var(--w-carbon)] text-white" : "bg-background text-muted-foreground hover:text-foreground"}`}
              onClick={() => setViewMode("matrix")}
            >
              <LayoutGrid className="h-3 w-3" />
              Matrix
            </button>
          </div>
          <Button
            size="sm"
            className="bg-[var(--w-carbon)] hover:bg-[var(--w-ink)] text-white gap-1.5"
            onClick={() => setForm(f => ({ ...f, showForm: !f.showForm }))}
          >
            <Plus className="h-3.5 w-3.5" />
            Add Action
          </Button>
        </div>
      </header>

      {/* Add form */}
      {form.showForm && (
        <Card className="border-[var(--w-rule)]">
          <CardContent className="p-4 space-y-3">
            <Textarea
              placeholder="What needs to be done?"
              value={form.text}
              onChange={(e) => setForm(f => ({ ...f, text: e.target.value }))}
              rows={2}
            />
            <div className="flex gap-3 flex-wrap">
              <Input
                placeholder="Owner"
                value={form.owner}
                onChange={(e) => setForm(f => ({ ...f, owner: e.target.value }))}
                className="flex-1 min-w-28 text-[16px] sm:text-sm"
              />
              <Input
                type="date"
                value={form.due}
                onChange={(e) => setForm(f => ({ ...f, due: e.target.value }))}
                className="w-full sm:w-38 text-[16px] sm:text-sm"
              />
              <select
                value={form.priority}
                onChange={(e) => setForm(f => ({ ...f, priority: e.target.value as NonNullable<ActionItem["priority"]> }))}
                className="h-10 rounded-lg border border-border bg-background px-3 text-[16px] sm:text-sm"
              >
                <option value="high">🔴 High</option>
                <option value="medium">🟡 Medium</option>
                <option value="low">⚪ Low</option>
              </select>
              <select
                value={form.source}
                onChange={(e) => setForm(f => ({ ...f, source: e.target.value as ActionItem["source"] }))}
                className="h-10 rounded-lg border border-border bg-background px-3 text-[16px] sm:text-sm"
              >
                <option value="manual">Manual</option>
                <option value="meeting">Meeting</option>
                <option value="slack">Slack</option>
                <option value="email">Email</option>
                <option value="chat">Chat</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={handleAdd}
                className="bg-[var(--w-carbon)] text-white hover:bg-[var(--w-ink)]"
              >
                Save
              </Button>
              <Button size="sm" variant="outline" onClick={clearForm}>
                Cancel
              </Button>
              <DraftSavedIndicator saved={formDraftSaved} className="ml-1" />
            </div>
          </CardContent>
        </Card>
      )}

      {/* What actually wants you, before the list of everything.
          The page used to open on all commitments with the pressing ones
          somewhere inside; these are the same counts the sections below use,
          so the lead can never disagree with the list. */}
      {!loading && (
        <NeedsAttention
          buckets={[
            { label: "Overdue", count: overdue.length, urgent: true, onClick: () => setStatusFilter("overdue") },
            { label: "Due today", count: dueToday.length, onClick: () => setStatusFilter("open") },
            ...(reviewItems.length > 0
              ? [{ label: "Needs review", count: reviewItems.length, onClick: () => setStatusFilter("review") }]
              : []),
          ]}
          allClear={
            openCount > 0
              ? `Nothing overdue or due today. ${openCount} commitment${openCount === 1 ? "" : "s"} open further out.`
              : "No open commitments."
          }
          unavailable={fetchError ? "Commitments could not be read, so a zero count here would be a guess." : undefined}
        />
      )}

      {/* Filters */}
      <div className="flex gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search actions or owner…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-10 rounded-lg border border-border bg-background px-3 text-sm"
        >
          <option value="all">All ({actions.length})</option>
          <option value="open">Open ({openCount})</option>
          <option value="done">Done</option>
          <option value="overdue">Overdue</option>
          {reviewItems.length > 0 && (
            <option value="review">Needs Review ({reviewItems.length})</option>
          )}
        </select>
      </div>

      {/* Content + Completed sidebar */}
      <div className="grid lg:grid-cols-[1fr_280px] gap-6 items-start">
      <div className="min-w-0 space-y-6">
      {/* Content */}
      {loading ? (
        <div className="space-y-3">
          {[1,2,3].map((i) => (
            <Card key={i}>
              <CardContent className="py-4 space-y-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/3" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : fetchError ? (
        <Card>
          <CardContent className="py-2">
            <DataState error={fetchError} onRetry={refresh} />
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl basil-card p-12 text-center space-y-3">
          <CheckSquare className="h-12 w-12 mx-auto text-muted-foreground/30" />
          <h2 className="text-xl font-semibold">No actions found yet</h2>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            Basil extracts commitments from Slack DMs, @-mentions and emails automatically.
            Add one manually, or sync recent activity to let Basil look.
          </p>
          <div className="flex items-center justify-center gap-3 flex-wrap">
            <button
              onClick={() => setForm(f => ({ ...f, showForm: true }))}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--w-carbon)] text-white text-sm font-semibold px-4 py-2 hover:brightness-105 transition"
            >
              <Plus className="h-4 w-4" />
              Add action
            </button>
            <ActionsSyncButton onSynced={refresh} />
          </div>
        </div>

      ) : viewMode === "category" ? (
        /* ── Category view ──────────────────────────────────────────────── */
        <div className="space-y-6">
          {/* Needs Review — always on top */}
          {reviewItems.length > 0 && (
            <CollapsibleSection
              label="Needs Review"
              accent="text-signal-warning"
              items={reviewItems}
              defaultOpen={true}
              onToggle={toggleDone}
              onDelete={handleDelete}
              onNotes={handleNotes}
              onConfirmReview={handleConfirmReview}
              onDecisionClick={handleDecisionClick}
              todayStr={todayStr}
              photos={photos}
            />
          )}

          {/* Decision needed — urgent signal section */}
          {decisionNeeded.length > 0 && (
            <CollapsibleSection
              label="Decision Needed"
              accent="text-signal-info"
              items={decisionNeeded}
              defaultOpen={true}
              onToggle={toggleDone}
              onDelete={handleDelete}
              onNotes={handleNotes}
              onConfirmReview={handleConfirmReview}
              onDecisionClick={handleDecisionClick}
              todayStr={todayStr}
              photos={photos}
            />
          )}

          {/* Critical / role + project */}
          <CollapsibleSection
            label="Critical — Role & Project"
            accent="text-signal-critical"
            items={critical}
            defaultOpen={true}
            onToggle={toggleDone}
            onDelete={handleDelete}
            onConfirmReview={handleConfirmReview}
            onDecisionClick={handleDecisionClick}
            todayStr={todayStr}
          />

          {/* Admin */}
          <CollapsibleSection
            label="Admin & Operations"
            accent="text-signal-info"
            items={adminActs}
            defaultOpen={true}
            onToggle={toggleDone}
            onDelete={handleDelete}
            onConfirmReview={handleConfirmReview}
            onDecisionClick={handleDecisionClick}
            todayStr={todayStr}
          />

          {/* Personal */}
          <CollapsibleSection
            label="Personal"
            accent="text-signal-positive"
            items={personal}
            defaultOpen={true}
            onToggle={toggleDone}
            onDelete={handleDelete}
            onConfirmReview={handleConfirmReview}
            onDecisionClick={handleDecisionClick}
            todayStr={todayStr}
          />

          {/* Uncategorized — collapsed by default */}
          {uncategorized.length > 0 && (
            <CollapsibleSection
              label="Uncategorized"
              items={uncategorized}
              defaultOpen={false}
              onToggle={toggleDone}
              onDelete={handleDelete}
              onNotes={handleNotes}
              onConfirmReview={handleConfirmReview}
              onDecisionClick={handleDecisionClick}
              todayStr={todayStr}
              photos={photos}
            />
          )}

          {/* Done — collapsed */}
          <CollapsibleSection
            label="Done"
            items={done}
            defaultOpen={false}
            onToggle={toggleDone}
            onDelete={handleDelete}
            todayStr={todayStr}
            photos={photos}
          />
        </div>

      ) : viewMode === "matrix" ? (
        /* ── Eisenhower Matrix view ──────────────────────────────────── */
        <MatrixView
          actions={filtered}
          classifying={classifying}
          classifyStatus={classifyStatus}
          onClassify={handleClassify}
          onToggle={toggleDone}
          onDelete={handleDelete}
          todayStr={todayStr}
        />

      ) : showGrouped ? (
        /* ── Timeline view (default) ──────────────────────────────────── */
        <div className="space-y-6">
          {/* Needs Review — amber section, shown only when items pending */}
          {statusFilter !== "review" && reviewItems.length > 0 && (
            <CollapsibleSection
              label="Needs Review"
              accent="text-signal-warning"
              items={reviewItems}
              defaultOpen={true}
              onToggle={toggleDone}
              onDelete={handleDelete}
              onNotes={handleNotes}
              onConfirmReview={handleConfirmReview}
              onDecisionClick={handleDecisionClick}
              todayStr={todayStr}
              photos={photos}
            />
          )}
          {statusFilter === "review" && (
            <>
              {filtered.length > 1 && (
                <div className="flex justify-end mb-2">
                  <button
                    type="button"
                    onClick={async () => {
                      if (!confirm(`Dismiss all ${filtered.length} review items? This cannot be undone.`)) return;
                      await Promise.all(filtered.map((a) => handleDelete(a.id)));
                    }}
                    className="text-xs text-muted-foreground hover:text-destructive border border-border rounded px-3 py-1.5 transition-colors"
                  >
                    Dismiss all ({filtered.length})
                  </button>
                </div>
              )}
              <CollapsibleSection
                label="Needs Review"
                accent="text-signal-warning"
                items={filtered}
                defaultOpen={true}
                onToggle={toggleDone}
                onDelete={handleDelete}
              onNotes={handleNotes}
                onConfirmReview={handleConfirmReview}
                onDecisionClick={handleDecisionClick}
                todayStr={todayStr}
                photos={photos}
              />
            </>
          )}

          {statusFilter !== "review" && (
            <>
              {/* Overdue */}
              {overdue.length > 0 && (
                <div>
                  <SectionHeading label="Overdue" count={overdue.length} accent="text-signal-critical" />
                  <div className="space-y-2">
                    {overdue.map((a) => (
                      <ActionCard
                        key={a.id}
                        action={a}
                        onToggle={toggleDone}
                        onDelete={handleDelete}
              onNotes={handleNotes}
                        onConfirmReview={handleConfirmReview}
                        onDecisionClick={handleDecisionClick}
                        todayStr={todayStr}
                        photos={photos}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Due today */}
              {dueToday.length > 0 && (
                <div>
                  <SectionHeading label="Due Today" count={dueToday.length} accent="text-signal-warning" />
                  <div className="space-y-2">
                    {dueToday.map((a) => (
                      <ActionCard
                        key={a.id}
                        action={a}
                        onToggle={toggleDone}
                        onDelete={handleDelete}
              onNotes={handleNotes}
                        onConfirmReview={handleConfirmReview}
                        onDecisionClick={handleDecisionClick}
                        todayStr={todayStr}
                        photos={photos}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Upcoming */}
              {upcoming.length > 0 && (
                <div>
                  <SectionHeading label="Upcoming" count={upcoming.length} />
                  <div className="space-y-2">
                    {upcoming.map((a) => (
                      <ActionCard
                        key={a.id}
                        action={a}
                        onToggle={toggleDone}
                        onDelete={handleDelete}
              onNotes={handleNotes}
                        onConfirmReview={handleConfirmReview}
                        onDecisionClick={handleDecisionClick}
                        todayStr={todayStr}
                        photos={photos}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Open (no due date) */}
              {openNoDue.length > 0 && (
                <div>
                  <SectionHeading label="Open" count={openNoDue.length} />
                  <div className="space-y-2">
                    {openNoDue.map((a) => (
                      <ActionCard
                        key={a.id}
                        action={a}
                        onToggle={toggleDone}
                        onDelete={handleDelete}
              onNotes={handleNotes}
                        onConfirmReview={handleConfirmReview}
                        onDecisionClick={handleDecisionClick}
                        todayStr={todayStr}
                        photos={photos}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Stalled — collapsed by default */}
              <CollapsibleSection
                label="Stalled"
                accent="text-signal-warning"
                items={stalled}
                archive
                note="No due date and no movement for weeks. These are not overdue — they are forgotten. Give one a date or delete it."
                defaultOpen={false}
                onToggle={toggleDone}
                onDelete={handleDelete}
              onNotes={handleNotes}
                onConfirmReview={handleConfirmReview}
                onDecisionClick={handleDecisionClick}
                todayStr={todayStr}
                photos={photos}
              />

              {/* Done — collapsed by default */}
              <CollapsibleSection
                label="Done"
                items={done}
                archive
                note="Completed work, kept for the record."
                defaultOpen={false}
                onToggle={toggleDone}
                onDelete={handleDelete}
              onNotes={handleNotes}
                todayStr={todayStr}
                photos={photos}
              />
            </>
          )}
        </div>
      ) : (
        // Flat list for non-grouped status filters
        <div className="space-y-2">
          {filtered.map((a) => (
            <ActionCard
              key={a.id}
              action={a}
              onToggle={toggleDone}
              onDelete={handleDelete}
              onNotes={handleNotes}
              onConfirmReview={handleConfirmReview}
              onDecisionClick={handleDecisionClick}
              todayStr={todayStr}
              photos={photos}
            />
          ))}
        </div>
      )}
      </div>{/* end left column */}
      {!loading && done.length > 0 && (
        <CompletedActionsPanel items={done} todayStr={todayStr} />
      )}
      </div>{/* end grid */}

      {/* ── Undo toast ──────────────────────────────────────────────────── */}
      {undoEntry && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-xl bg-foreground text-background px-4 py-2.5 shadow-xl text-sm font-medium animate-in slide-in-from-bottom-2 duration-200">
          <RotateCcw className="h-3.5 w-3.5 shrink-0 opacity-70" />
          <span className="max-w-[260px] truncate opacity-80">{undoEntry.label}</span>
          <button
            onClick={handleUndo}
            className="ml-1 text-[var(--w-carbon)] hover:text-[oklch(0.80_0.15_85)] font-semibold transition-colors"
          >
            Undo
          </button>
          <button
            onClick={() => { if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current); setUndoEntry(null); }}
            className="opacity-50 hover:opacity-80 transition-opacity"
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
