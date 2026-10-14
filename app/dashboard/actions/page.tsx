"use client";

/**
 * Commitments — what you have promised, and what others owe you.
 *
 * Restyled 2026-10-14 to the Basil identity (docs/design/visual-system.md):
 * cream cards, navy chrome, Instrument Serif headings, and one graphic, "Your
 * load", counted from the actions this page already holds. Data fetching,
 * handlers, filters and what marking done / deleting sends are unchanged.
 */

import { Fragment, useState, useEffect, useRef, useCallback, useMemo } from "react";
import { ReplyButton } from "@/components/email/reply-composer";
import { useDomainSync } from "@/lib/sync/use-domain-sync";
// useDraft kept for any legacy callers; actions now uses usePersistentDraft
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PageHero, BTN_PRIMARY, BTN_SECONDARY } from "@/components/basil/page-hero";

import { ContactAvatar } from "@/components/ui/contact-avatar";
import { useContactPhotos } from "@/lib/hooks/use-contact-photos";
import {
  Plus,
  Trash2,
  Check,
  Search,
  Clock,
  Link2,
  ChevronDown,
  ChevronRight,
  ShieldQuestion,
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
  AlertTriangle,
  Info,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { findContactByName } from "@/lib/contacts-lookup";
import { isActionStalled, isWaitingOnOthers } from "@/lib/actions/utils";
import { cn } from "@/lib/utils";
import { dashboardCache } from "@/lib/dashboard-cache";
import type { ActionItem, ActionCategory } from "@/lib/types/action";
import { DataState } from "@/components/ui/data-state";
import { usePersistentDraft } from "@/lib/hooks/use-persistent-draft";
import { DraftSavedIndicator } from "@/components/ui/draft-saved-indicator";
import { TrustReviewPrompt } from "@/components/ui/trust-ui";
import { ExplorePanel } from "@/components/explore-panel";
import { daysSince } from "@/lib/today/visual-data";

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

// ── Palette (exactly the validated chart colours from the visual system) ──────

/** "Your load" states. Later is the palest step of the sequential ramp, outlined. */
const LOAD_COLOR = { overdue: "#D9661F", today: "#2F5FA8", week: "#1F8A70", later: "#A9B4CC" } as const;
/** Channel colours, shown as a dot beside ink text (never as text colour). */
const CHANNEL_DOT: Partial<Record<ActionItem["source"], string>> = {
  email: "#5865C2",
  slack: "#0E9E8A",
  meeting: "#BE7A2A",
  chat: "#C8A96B",
};
const SOURCE_LABEL: Record<ActionItem["source"], string> = {
  meeting: "Meeting",
  slack: "Slack",
  teams: "Teams",
  email: "Email",
  manual: "Manual",
  chat: "Chat",
  linear: "Linear",
};

/** A swatch for a chart colour: the palest one gets a rule border so it never vanishes on cream. */
function swatchStyle(color: string): React.CSSProperties {
  return color === LOAD_COLOR.later
    ? { background: color, border: "1px solid var(--w-rule)" }
    : { background: color };
}

/** A small outlined chip. Opaque cream ground, so whatever text sits on it keeps AA. */
const CHIP = "inline-flex items-center gap-1 rounded-full border bg-[var(--w-flimsy)] px-2 py-0.5 text-[12px] font-medium";

// ── Visual helpers ─────────────────────────────────────────────────────────────

function CountChip({ n }: { n: number }) {
  return (
    <span className="basil-mono inline-flex min-w-[28px] items-center justify-center rounded-full border border-[var(--w-rule)] bg-[var(--w-tray)] px-2 py-0.5 text-[12px] text-[color:var(--w-ink)]">
      {n}
    </span>
  );
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase() || "?";
}

function PriorityBadge({ priority }: { priority?: ActionItem["priority"] }) {
  if (!priority) return null;
  const styles: Record<NonNullable<ActionItem["priority"]>, string> = {
    high: "border-[var(--w-stamp)] text-[color:var(--w-stamp)]",
    medium: "border-[var(--w-rule-strong)] text-[color:var(--w-manila)]",
    low: "border-[var(--w-rule)] text-[color:var(--w-ink-soft)]",
  };
  return (
    <span className={`${CHIP} ${styles[priority]}`}>
      {priority[0].toUpperCase() + priority.slice(1)}
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
      ? `${minLeft}m left`
      : minLeft < 240
        ? `${Math.floor(minLeft / 60)}h ${minLeft % 60}m left`
        : `expires ${new Date(expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  const urgency = minLeft < 30
    ? "border-[var(--w-stamp)] text-[color:var(--w-stamp)]"
    : minLeft < 120
      ? "border-[var(--w-manila)] text-[color:var(--w-manila)]"
      : "border-[var(--w-rule)] text-[color:var(--w-ink-soft)]";
  return (
    <span className={`${CHIP} ${urgency}`} title={`Expires at ${new Date(expiresAt).toLocaleString()}`}>
      <Clock className="h-3 w-3" aria-hidden />
      <span className="basil-mono">{label}</span>
    </span>
  );
}

/** Where it came from: a channel-coloured dot beside ink text (the safe way to use a hue). */
function SourceBadge({ source }: { source: ActionItem["source"] }) {
  const dot = CHANNEL_DOT[source];
  return (
    <span className={`${CHIP} border-[var(--w-rule)] text-[color:var(--w-ink)]`}>
      <span
        aria-hidden
        className="h-2 w-2 shrink-0 rounded-full"
        style={dot ? { background: dot } : { border: "1.5px solid var(--w-rule-strong)" }}
      />
      {SOURCE_LABEL[source] ?? source}
    </span>
  );
}

/** Shown on actions that need user confirmation before being trusted. */
function NeedsReviewBadge() {
  return (
    <span className={`${CHIP} border-[var(--w-manila)] text-[color:var(--w-manila)]`}>
      <ShieldQuestion className="h-3 w-3" aria-hidden />
      Review
    </span>
  );
}

/** Compact category chip. */
function CategoryChip({ category }: { category?: ActionCategory }) {
  if (!category) return null;
  const styles: Record<ActionCategory, { cls: string; label: string; Icon: React.ComponentType<{ className?: string }> }> = {
    critical: { cls: "text-[color:var(--w-stamp)]", label: "Critical", Icon: Briefcase },
    admin:    { cls: "text-[color:var(--w-info)]",  label: "Admin",    Icon: ClipboardList },
    personal: { cls: "text-[color:var(--w-filed)]", label: "Personal", Icon: User },
  };
  const { cls, label, Icon } = styles[category];
  return (
    <span className={`${CHIP} border-[var(--w-rule)] ${cls}`}>
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}

/** Decision-required pill — click navigates to Decisions page. */
function DecisionRequiredBadge({ onClick }: { onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${CHIP} cursor-pointer border-[var(--w-info)] text-[color:var(--w-info)] transition-colors hover:border-[#10213F]`}
      title="A decision needs to be made — click to log it"
    >
      <GitBranch className="h-3 w-3" aria-hidden />
      Decision needed
    </button>
  );
}

// ── Section headings ───────────────────────────────────────────────────────────

/** Group heading: serif title, an optional swatch tying it to "Your load", and a count chip. */
function SectionHeading({
  id,
  label,
  count,
  dot,
}: {
  id?: string;
  label: string;
  count: number;
  dot?: string;
}) {
  return (
    <div className="flex items-center gap-2.5 pb-1">
      {dot && <span aria-hidden className="h-3 w-3 shrink-0 rounded-[3px]" style={swatchStyle(dot)} />}
      <h3 id={id} className="basil-serif text-[22px] leading-tight text-[#10213F]">
        {label}
      </h3>
      <CountChip n={count} />
    </div>
  );
}

/** A timeline group: one cream card, its rows sharing a rule inside it. */
function GroupCard({
  id,
  label,
  count,
  dot,
  delay = 0,
  children,
}: {
  id: string;
  label: string;
  count: number;
  dot?: string;
  delay?: number;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-h`}
      className="basil-rise scroll-mt-6 rounded-[20px] border border-[var(--w-rule)] bg-[var(--w-flimsy)] px-4 pb-1.5 pt-4 sm:px-6"
      style={{ animationDelay: `${delay}ms` }}
    >
      <SectionHeading id={`${id}-h`} label={label} count={count} dot={dot} />
      <div>{children}</div>
    </section>
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
  onReplied,
  todayStr,
  photos = {},
}: {
  action: ActionItem;
  /** After a reply is sent from this card (the server closes the action). */
  onReplied?: () => void;
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
  const isDone = action.status === "done";

  return (
    // A filed commitment: a row inside its group's card, sharing one rule with
    // its neighbours so the queue stays dense enough to work down. Done items
    // stay legible (struck through, never faded) — a completed commitment is
    // evidence you acted, and this app has a standing problem with outbound
    // work being invisible.
    <article className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 border-t border-[var(--w-rule)] py-3.5 first:border-t-0">
      {/* Checkbox */}
      <label className="-ml-1.5 flex h-8 w-8 cursor-pointer items-start justify-center pt-[3px]">
        <input
          type="checkbox"
          checked={isDone}
          onChange={() => onToggle(action.id)}
          aria-label={isDone ? `Mark "${action.text.slice(0, 60)}" as not done` : `Mark "${action.text.slice(0, 60)}" done`}
          className="h-[18px] w-[18px] cursor-pointer accent-[#10213F]"
        />
      </label>

      {/* Body */}
      <div className="min-w-0">
        <p
          className={`text-[15px] leading-snug ${
            isDone ? "text-[color:var(--w-ink-soft)] line-through" : "text-[color:var(--w-ink)]"
          }`}
        >
          {action.text}
        </p>
        {/* A promise you made in writing — shows whom to, when, and your words. */}
        {action.commitment && (
          <p className="mt-1 text-[13px] text-[color:var(--w-ink-soft)]">
            You promised{action.commitment.to ? ` ${action.commitment.to}` : ""}
            {" · "}<span className="basil-mono">{new Date(action.commitment.sentAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
            {action.commitment.quote ? <span className="italic">{` — “${action.commitment.quote}”`}</span> : null}
          </p>
        )}

        {/* Meta row */}
        <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          {/* Resolution marker. Signal-driven closes (you accepted an invite /
              sent a reply) read as what you DID; lifecycle sweeps read as
              auto-archived. Neither is conflated with a manual completion. */}
          {action.archivedReason && (() => {
            const signalDriven = action.archivedReason === "rsvp-confirmed" || action.archivedReason === "reply-sent"
              || action.archivedReason === "answered-elsewhere" || action.archivedReason === "promise-kept";
            const label =
              action.archivedReason === "rsvp-confirmed" ? "you responded on your calendar"
              : action.archivedReason === "reply-sent" ? "you replied"
              : action.archivedReason === "answered-elsewhere" ? "answered in the thread"
              : action.archivedReason === "bulk-mail" ? "marketing mail"
              : action.archivedReason === "calendar-invite" ? "on your calendar"
              : action.archivedReason === "promise-kept" ? "you followed through"
              : action.archivedReason === "notification" ? "automatic notification"
              : action.archivedReason === "meeting-note" ? "meeting note, not a task"
              : action.archivedReason === "stale-untouched" ? "untouched 30 days"
              : action.archivedReason === "stale-overdue" ? "expired overdue"
              : action.archivedReason === "past-meeting" ? "meeting passed"
              : "time-boxed";
            return (
              <span className={cn(
                CHIP,
                "text-[11px] uppercase tracking-wide",
                signalDriven
                  ? "border-[var(--w-filed)] text-[color:var(--w-filed)]"
                  : "border-[var(--w-rule)] text-[color:var(--w-ink-soft)]"
              )}>
                {signalDriven ? "" : "Auto-archived · "}{label}
              </span>
            );
          })()}
          {/* Owner — a small initials chip (their headshot when Basil has one) */}
          {action.owner && (
            <span className="inline-flex items-center gap-1.5 text-[13px] text-[color:var(--w-ink-soft)]">
              <ContactAvatar
                initials={contact?.initials ?? initialsOf(action.owner)}
                color="bg-[#10213F]"
                photoUrl={contact ? photos[contact.email?.toLowerCase() ?? ""] : undefined}
                className="h-6 w-6"
                fallbackClassName="text-[10px] font-semibold"
              />
              {action.owner}
            </span>
          )}

          {/* Due date */}
          {action.dueDate && (
            <span
              className={`basil-mono text-[12px] font-medium ${
                isOverdue
                  ? "text-[color:var(--w-stamp)]"
                  : isDueToday
                  ? "text-[color:var(--w-manila)]"
                  : "text-[color:var(--w-ink-soft)]"
              }`}
            >
              {isOverdue ? "Overdue · " : ""}{isDueToday ? "Due today" : `Due ${formatDueDate(action.dueDate)}`}
            </span>
          )}

          {/* Stalled indicator */}
          {stalled && (
            <span className="inline-flex items-center gap-1 text-[12px] font-medium text-[color:var(--w-manila)]">
              <Clock className="h-3 w-3" aria-hidden />
              Stalled
            </span>
          )}

          {/* Reply in the email thread this action came from — sending closes it. */}
          {action.source === "email" && action.sourceRef?.startsWith("gmail:") && action.status !== "done" && (
            <ReplyButton messageId={action.sourceRef.slice("gmail:".length)} actionId={action.id} onSent={onReplied} />
          )}
          <ExpiryBadge expiresAt={action.expiresAt} />
          <PriorityBadge priority={action.priority} />
          <SourceBadge source={action.source} />
          <CategoryChip category={action.category} />
          {action.needsReview && <NeedsReviewBadge />}

          {/* Decision needed — click-through to Decisions */}
          {action.decisionRequired && !action.linkedDecisionId && (
            <DecisionRequiredBadge onClick={() => onDecisionClick?.(action)} />
          )}

          {/* Linked decisions */}
          {action.linkedDecisionIds && action.linkedDecisionIds.length > 0 && (
            <span className="inline-flex items-center gap-1 text-[12px] text-[color:var(--w-ink-soft)]" title="Linked decisions">
              <Link2 className="h-3 w-3" aria-hidden />
              <span className="basil-mono">{action.linkedDecisionIds.length}</span>
            </span>
          )}
        </div>

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
        type="button"
        onClick={() => onDelete(action.id)}
        className="-mr-2 -mt-1.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[color:var(--w-ink-soft)] transition-colors hover:bg-[var(--w-tray)] hover:text-[color:var(--w-stamp)]"
        title="Delete action"
        aria-label="Delete action"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </article>
  );
}

// ── Collapsible section wrapper ────────────────────────────────────────────────

function CollapsibleSection({
  id,
  label,
  dot,
  items,
  note,
  archive = false,
  defaultOpen = true,
  delay = 0,
  onToggle,
  onDelete,
  onConfirmReview,
  onDecisionClick,
  onNotes,
  onReplied,
  todayStr,
  photos = {},
}: {
  id?: string;
  onReplied?: () => void;
  label: string;
  /** Swatch colour tying the group to a chart state. */
  dot?: string;
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
  delay?: number;
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
    <section
      id={id}
      className={`basil-rise scroll-mt-6 rounded-[20px] border border-[var(--w-rule)] px-4 pb-1.5 pt-2 sm:px-6 ${
        archive ? "bg-[var(--w-tray)]" : "bg-[var(--w-flimsy)]"
      }`}
      style={{ animationDelay: `${delay}ms` }}
    >
      {archive && (
        <p className="basil-mono pt-2 text-[11px] uppercase tracking-[0.14em] text-[color:var(--w-ink-soft)]">
          Archive
        </p>
      )}
      <button
        type="button"
        className="flex min-h-[44px] w-full items-center gap-2.5 rounded-lg text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#10213F]"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-[color:var(--w-ink-soft)]" aria-hidden />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-[color:var(--w-ink-soft)]" aria-hidden />
        )}
        {dot && <span aria-hidden className="h-3 w-3 shrink-0 rounded-[3px]" style={swatchStyle(dot)} />}
        <span className={`basil-serif leading-tight text-[#10213F] ${archive ? "text-[20px]" : "text-[22px]"}`}>
          {label}
        </span>
        <CountChip n={items.length} />
      </button>
      {open && note && (
        <p className="pb-2 text-[13px] leading-relaxed text-[color:var(--w-ink-soft)]">{note}</p>
      )}
      {open && (
        <div>
          {items.map((a) => (
            <ActionCard
              key={a.id}
              action={a}
              onToggle={onToggle}
              onDelete={onDelete}
              onConfirmReview={onConfirmReview}
              onDecisionClick={onDecisionClick}
              onNotes={onNotes}
              onReplied={onReplied}
              todayStr={todayStr}
              photos={photos}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// ── Your load (the graphic under the header) ──────────────────────────────────

type LoadKey = "overdue" | "today" | "week" | "later";

interface LoadCounts {
  overdue: number;
  today: number;
  week: number;
  /** Dated beyond this week. */
  laterDated: number;
  /** No due date (includes stalled). */
  noDate: number;
  stalled: number;
}

/**
 * Your open commitments by when they are due, counted with the same rules the
 * groups below use (Overdue, Due Today, Upcoming split at seven days, Open +
 * Stalled), so with no search or filter the graphic and the list agree.
 */
function countLoad(list: ActionItem[], todayStr: string, weekEndStr: string): LoadCounts {
  const out: LoadCounts = { overdue: 0, today: 0, week: 0, laterDated: 0, noDate: 0, stalled: 0 };
  for (const a of list) {
    if (a.status === "done") continue;
    const due = a.dueDate ?? "";
    if (a.status === "overdue" || (due && due < todayStr)) out.overdue++;
    else if (due === todayStr) out.today++;
    else if (due && due.slice(0, 10) <= weekEndStr) out.week++;
    else if (due) out.laterDated++;
    else {
      out.noDate++;
      if (isActionStalled(a)) out.stalled++;
    }
  }
  return out;
}

const LOAD_SEGMENTS: Array<{ key: LoadKey; label: string; color: string; hint: string }> = [
  { key: "overdue", label: "Overdue", color: LOAD_COLOR.overdue, hint: "past their due date" },
  { key: "today", label: "Due today", color: LOAD_COLOR.today, hint: "due before the day is out" },
  { key: "week", label: "This week", color: LOAD_COLOR.week, hint: "due in the next seven days" },
  { key: "later", label: "Later or no date", color: LOAD_COLOR.later, hint: "due after this week, or with no date set" },
];

const FILTER_LABEL: Record<string, string> = {
  open: "open commitments only",
  done: "done only",
  overdue: "overdue only",
  waiting: "what others owe you",
  review: "items to review",
};

function LoadPanel({
  counts,
  review,
  waiting,
  longestWait,
  failed,
  loading,
  activeFilter,
  onSegment,
  onWaiting,
  onReview,
  onClearFilter,
  delay = 0,
}: {
  counts: LoadCounts;
  review: number;
  waiting: number;
  longestWait: number;
  failed: boolean;
  loading: boolean;
  activeFilter: string;
  onSegment: (key: LoadKey) => void;
  onWaiting: () => void;
  onReview: () => void;
  onClearFilter: () => void;
  delay?: number;
}) {
  const [hover, setHover] = useState<LoadKey | null>(null);
  const value = (k: LoadKey) => (k === "later" ? counts.laterDated + counts.noDate : counts[k]);
  const total = counts.overdue + counts.today + counts.week + counts.laterDated + counts.noDate;
  const attention = counts.overdue + counts.today + review;
  const verb = (k: LoadKey) => (k === "overdue" ? "Show only these" : "Jump to them");
  const focus = hover ? LOAD_SEGMENTS.find((s) => s.key === hover) : undefined;

  // The lead the page used to open with ("N need attention"), kept as the
  // caption. Counts arrive derived; an outage is never reported as all clear.
  const summary = attention > 0
    ? `${attention} need${attention === 1 ? "s" : ""} attention: ${counts.overdue} overdue, ${counts.today} due today${review > 0 ? `, ${review} to review` : ""}.`
    : total > 0
      ? `Nothing overdue or due today. ${total} commitment${total === 1 ? "" : "s"} open further out.`
      : "No open commitments.";
  const detail = focus
    ? `${value(focus.key)} ${focus.label.toLowerCase()} — ${focus.hint}. ${verb(focus.key)}.`
    : summary;

  return (
    <section
      aria-labelledby="load-h"
      className="basil-rise flex flex-col gap-4 rounded-[20px] border border-[var(--w-rule)] bg-[var(--w-flimsy)] p-5 sm:p-6"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2.5">
        <h2 id="load-h" className="basil-serif text-[26px] leading-tight text-[#10213F]">Your load</h2>
        {!failed && !loading && (
          <span className="text-[13px] text-[color:var(--w-ink-soft)]">
            <span className="basil-mono font-semibold text-[color:var(--w-ink)]">{total}</span> open and yours
          </span>
        )}
      </div>

      {failed ? (
        <p className="flex items-start gap-2 text-[14px] leading-relaxed text-[color:var(--w-ink)]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--w-manila)]" aria-hidden />
          <span>
            <strong className="font-semibold">Cannot tell what needs attention.</strong>{" "}
            Commitments could not be read, so a zero count here would be a guess.
          </span>
        </p>
      ) : loading ? (
        <div className="h-12 animate-pulse rounded-[10px] bg-[var(--w-tray)]" aria-label="Reading your commitments" />
      ) : (
        <div className="flex flex-wrap items-stretch gap-5">
          <div className="flex min-w-0 flex-[3_1_420px] flex-col gap-2.5">
            {total === 0 ? (
              <div className="h-12 rounded-[10px] border border-[var(--w-rule)] bg-[var(--w-tray)]" aria-hidden />
            ) : (
              <div
                className="basil-grow flex h-12 gap-[2px]"
                style={{ animationDelay: `${delay + 180}ms` }}
                onMouseLeave={() => setHover(null)}
              >
                {LOAD_SEGMENTS.filter((s) => value(s.key) > 0).map((s) => {
                  const n = value(s.key);
                  const lit = hover === s.key || (s.key === "overdue" && activeFilter === "overdue");
                  return (
                    <button
                      key={s.key}
                      type="button"
                      // The legend below carries keyboard focus for the same
                      // actions; the bar stays one tab stop lighter.
                      tabIndex={-1}
                      onClick={() => onSegment(s.key)}
                      onMouseEnter={() => setHover(s.key)}
                      aria-label={`${s.label}: ${n}. ${verb(s.key)}.`}
                      title={`${s.label}: ${n}`}
                      className="min-w-[14px] cursor-pointer rounded-[4px] outline outline-2 outline-offset-2 transition-[outline-color] first:rounded-l-[10px] last:rounded-r-[10px]"
                      style={{ ...swatchStyle(s.color), flex: `${n} 1 0%`, outlineColor: lit ? "#10213F" : "transparent" }}
                    />
                  );
                })}
              </div>
            )}
            <div className="-mx-2.5 flex flex-wrap" role="group" aria-label="Your open commitments by when they are due">
              {LOAD_SEGMENTS.map((s, i) => {
                const n = value(s.key);
                return (
                  <button
                    key={s.key}
                    type="button"
                    disabled={n === 0}
                    onClick={() => onSegment(s.key)}
                    onMouseEnter={() => setHover(s.key)}
                    onMouseLeave={() => setHover(null)}
                    onFocus={() => setHover(s.key)}
                    onBlur={() => setHover(null)}
                    aria-pressed={s.key === "overdue" ? activeFilter === "overdue" : undefined}
                    aria-label={`${s.label}: ${n}.${n > 0 ? ` ${verb(s.key)}.` : ""}`}
                    className={`basil-rise inline-flex min-h-[44px] items-center gap-2 rounded-xl px-2.5 text-[14px] text-[color:var(--w-ink)] transition-colors enabled:hover:bg-[var(--w-tray)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#10213F] ${
                      hover === s.key ? "underline decoration-[#C8A96B] decoration-2 underline-offset-4" : ""
                    }`}
                    style={{ animationDelay: `${delay + 260 + i * 70}ms` }}
                  >
                    <span aria-hidden className="h-3 w-3 shrink-0 rounded-[3px]" style={swatchStyle(s.color)} />
                    {s.label}
                    <span className="basil-mono font-semibold">{n}</span>
                  </button>
                );
              })}
            </div>
            <p aria-live="polite" className="text-[13px] leading-relaxed text-[color:var(--w-ink-soft)]">{detail}</p>
          </div>

          {/* What others owe you: the count and the longest wait (from when Basil filed it). */}
          {waiting > 0 ? (
            <button
              type="button"
              onClick={onWaiting}
              aria-pressed={activeFilter === "waiting"}
              aria-label={`Waiting on others: ${waiting}. Longest wait ${longestWait} day${longestWait === 1 ? "" : "s"}. Show them.`}
              className={`basil-lift flex min-w-[200px] flex-[1_1_220px] flex-col items-start justify-center gap-1.5 rounded-[16px] border bg-[var(--w-tray)] px-5 py-4 text-left ${
                activeFilter === "waiting" ? "border-[#10213F]" : "border-[var(--w-rule)]"
              }`}
            >
              <span className="basil-mono text-[11px] uppercase tracking-[0.14em] text-[color:var(--w-ink-soft)]">Waiting on others</span>
              <span className="flex items-baseline gap-2">
                <span className="basil-serif text-[44px] leading-none text-[#10213F]">{waiting}</span>
                <span className="text-[14px] text-[color:var(--w-ink)]">{waiting === 1 ? "thing owed to you" : "things owed to you"}</span>
              </span>
              <span className="text-[13px] text-[color:var(--w-ink-soft)]">
                Longest wait{" "}
                <span className="basil-mono font-semibold text-[color:var(--w-ink)]">
                  {longestWait} day{longestWait === 1 ? "" : "s"}
                </span>
              </span>
            </button>
          ) : (
            <div className="flex min-w-[200px] flex-[1_1_220px] flex-col items-start justify-center gap-1.5 rounded-[16px] border border-[var(--w-rule)] bg-[var(--w-tray)] px-5 py-4">
              <span className="basil-mono text-[11px] uppercase tracking-[0.14em] text-[color:var(--w-ink-soft)]">Waiting on others</span>
              <span className="text-[14px] text-[color:var(--w-ink)]">Nobody owes you anything right now.</span>
            </div>
          )}
        </div>
      )}

      {!failed && !loading && (review > 0 || activeFilter !== "all") && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[var(--w-rule)] pt-3">
          {review > 0 && (
            <button type="button" onClick={onReview} aria-pressed={activeFilter === "review"} className={BTN_SECONDARY}>
              <ShieldQuestion className="h-4 w-4 text-[color:var(--w-manila)]" aria-hidden />
              Needs review
              <span className="basil-mono font-semibold">{review}</span>
            </button>
          )}
          {activeFilter !== "all" && (
            <span className="inline-flex items-center gap-1 text-[13px] text-[color:var(--w-ink-soft)]">
              Showing {FILTER_LABEL[activeFilter] ?? activeFilter}.
              <button
                type="button"
                onClick={onClearFilter}
                className="inline-flex min-h-[44px] items-center px-1 font-medium text-[color:var(--w-carbon)] underline underline-offset-2"
              >
                Show all
              </button>
            </span>
          )}
        </div>
      )}
    </section>
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
      type="button"
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
      className={BTN_SECONDARY}
    >
      <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} aria-hidden />
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
    <aside
      aria-labelledby="completed-h"
      className="basil-rise sticky top-4 flex flex-col gap-3 rounded-[20px] border border-[var(--w-rule)] bg-[var(--w-flimsy)] p-5"
      style={{ animationDelay: "320ms" }}
    >
      <div className="flex items-center gap-2.5">
        <CheckCircle2 className="h-4 w-4 text-[color:var(--w-filed)]" aria-hidden />
        <h2 id="completed-h" className="basil-serif text-[22px] leading-tight text-[#10213F]">Completed</h2>
        <CountChip n={items.length} />
      </div>
      <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
        {dates.map((date) => (
          <div key={date}>
            <p className="basil-mono mb-1 text-[11px] uppercase tracking-[0.14em] text-[color:var(--w-ink-soft)]">
              {dateLabel(date)}
            </p>
            <div>
              {grouped.get(date)!.map((a) => (
                <div
                  key={a.id}
                  className="flex items-start gap-2 border-b border-[var(--w-rule)] py-2 last:border-0"
                >
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--w-filed)]" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 text-[13px] leading-snug text-[color:var(--w-ink)]">{a.text}</p>
                    {a.owner && (
                      <p className="mt-0.5 text-[12px] text-[color:var(--w-ink-soft)]">{a.owner}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </aside>
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
  /** Chart colour for the quadrant's mark (three-state palette; quiet = dashed ring). */
  color: string;
  quiet?: boolean;
  Icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
}> = [
  {
    id: "Q1",
    label: "Do first",
    sublabel: "Urgent + Important",
    verb: "DO",
    urgent: true,
    important: true,
    color: "#D9661F",
    Icon: Zap,
  },
  {
    id: "Q2",
    label: "Schedule",
    sublabel: "Not Urgent + Important",
    verb: "PLAN",
    urgent: false,
    important: true,
    color: "#1F8A70",
    Icon: Calendar,
  },
  {
    id: "Q3",
    label: "Delegate",
    sublabel: "Urgent + Not Important",
    verb: "DELEGATE",
    urgent: true,
    important: false,
    color: "#2F5FA8",
    Icon: ArrowRight,
  },
  {
    id: "Q4",
    label: "Eliminate",
    sublabel: "Not Urgent + Not Important",
    verb: "DROP",
    urgent: false,
    important: false,
    color: "#8A8F99",
    quiet: true,
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
  const isDone = action.status === "done";
  return (
    <div className="flex items-start gap-2.5 border-t border-[var(--w-rule)] py-2.5 first:border-t-0">
      <label className="-ml-1 flex h-7 w-7 shrink-0 cursor-pointer items-start justify-center pt-[2px]">
        <input
          type="checkbox"
          checked={isDone}
          onChange={() => onToggle(action.id)}
          title="Mark done"
          aria-label={`Mark "${action.text.slice(0, 60)}" done`}
          className="h-4 w-4 cursor-pointer accent-[#10213F]"
        />
      </label>
      <div className="min-w-0 flex-1">
        <p className={`text-[14px] leading-snug ${isDone ? "text-[color:var(--w-ink-soft)] line-through" : "text-[color:var(--w-ink)]"}`}>
          {action.text}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <ExpiryBadge expiresAt={action.expiresAt} />
          {action.dueDate && (
            <span className={`basil-mono text-[12px] font-medium ${isOverdue ? "text-[color:var(--w-stamp)]" : "text-[color:var(--w-ink-soft)]"}`}>
              {isOverdue ? "Overdue · " : ""}{formatDueDate(action.dueDate)}
            </span>
          )}
          {action.owner && action.owner.toLowerCase() !== "me" && (
            <span className="text-[12px] text-[color:var(--w-ink-soft)]">→ {action.owner}</span>
          )}
          {action.eisenhowerReason && (
            <span className="text-[12px] italic text-[color:var(--w-ink-soft)]">{action.eisenhowerReason}</span>
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
        type="button"
        onClick={() => onDelete(action.id)}
        className="-mr-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[color:var(--w-ink-soft)] transition-colors hover:bg-[var(--w-tray)] hover:text-[color:var(--w-stamp)]"
        title="Delete"
        aria-label="Delete action"
      >
        <Trash2 className="h-3.5 w-3.5" />
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4 text-[13px] text-[color:var(--w-ink-soft)]">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: "#D9661F" }} /> Urgent
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: "#1F8A70" }} /> Important
          </span>
          {classifiedCount > 0 && (
            <span><span className="basil-mono text-[color:var(--w-ink)]">{classifiedCount}/{open.length}</span> classified</span>
          )}
        </div>
        <button
          type="button"
          onClick={onClassify}
          disabled={classifying || open.length === 0}
          className={`${BTN_SECONDARY} disabled:cursor-not-allowed`}
        >
          {classifying ? (
            <><Loader2 className="h-4 w-4 animate-spin" aria-hidden />Classifying…</>
          ) : (
            <><Zap className="h-4 w-4 text-[color:var(--w-carbon)]" aria-hidden />{classifiedCount > 0 ? "Re-classify" : "Classify with Basil"}</>
          )}
        </button>
      </div>

      {/* Status banner — error or heuristic-fallback notice */}
      {classifyStatus && (
        <div className={`flex items-start gap-2 rounded-xl border bg-[var(--w-flimsy)] px-3.5 py-3 text-[13px] ${
          classifyStatus.type === "error"
            ? "border-[var(--w-stamp)] text-[color:var(--w-stamp)]"
            : classifyStatus.type === "warning"
              ? "border-[var(--w-manila)] text-[color:var(--w-manila)]"
              : "border-[var(--w-filed)] text-[color:var(--w-filed)]"
        }`}>
          {classifyStatus.type === "error" ? (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          ) : classifyStatus.type === "warning" ? (
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          ) : (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          )}
          <span>{classifyStatus.message}</span>
          {classifyStatus.type === "error" && (
            <a href="/dashboard/settings?tab=brain" className="ml-auto shrink-0 font-semibold underline">
              Configure brain →
            </a>
          )}
        </div>
      )}

      {/* The 2×2 grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {QUADRANTS.map((q, qi) => {
          const items = byQuadrant(q.id);
          const Icon = q.Icon;
          return (
            <section
              key={q.id}
              aria-labelledby={`quad-${q.id}`}
              className="basil-rise flex flex-col rounded-[20px] border border-[var(--w-rule)] bg-[var(--w-flimsy)]"
              style={{ animationDelay: `${120 + qi * 70}ms` }}
            >
              {/* Quadrant header */}
              <div className="flex items-center justify-between gap-2 px-5 pb-1.5 pt-4">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span
                    aria-hidden
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
                    style={q.quiet ? { border: "1.5px dashed #8A8F99" } : { background: q.color }}
                  >
                    <Icon className="h-3.5 w-3.5" style={{ color: q.quiet ? "var(--w-ink-soft)" : "#FFFDF8" }} />
                  </span>
                  <h3 id={`quad-${q.id}`} className="basil-serif text-[22px] leading-tight text-[#10213F]">{q.label}</h3>
                  <span className="hidden truncate text-[12px] text-[color:var(--w-ink-soft)] md:inline">{q.sublabel}</span>
                </div>
                {items.length > 0 && <CountChip n={items.length} />}
              </div>
              {/* Items */}
              <div className="min-h-[80px] px-5 pb-2">
                {items.length === 0 ? (
                  <p className="py-3 text-[13px] italic text-[color:var(--w-ink-soft)]">
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
            </section>
          );
        })}
      </div>

      {/* Unclassified overflow */}
      {unclassified.length > 0 && (
        <section aria-labelledby="quad-unclassified" className="basil-rise rounded-[20px] border border-[var(--w-rule)] bg-[var(--w-tray)]" style={{ animationDelay: "420ms" }}>
          <div className="flex flex-wrap items-center justify-between gap-2 px-5 pb-1.5 pt-4">
            <h3 id="quad-unclassified" className="basil-serif text-[20px] leading-tight text-[#10213F]">
              Unclassified
            </h3>
            <span className="text-[13px] text-[color:var(--w-ink-soft)]">
              <span className="basil-mono text-[color:var(--w-ink)]">{unclassified.length}</span> item{unclassified.length !== 1 ? "s" : ""} · run classify to sort
            </span>
          </div>
          <div className="px-5 pb-2">
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
        </section>
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
  // Whose action is it: someone else's commitment ("Carter to send…") is
  // waiting-on — tracked under its own filter, never in your list or counts.
  const [selfName, setSelfName] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { name?: string } | null) => { if (j?.name) setSelfName(j.name); })
      .catch(() => { /* without a name, every action is shown as yours — never hidden */ });
  }, []);
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
      // Close anything whose email/Slack conversation has moved on (you replied,
      // someone else answered, it was marketing). Server-throttled per action.
      try {
        const res = await fetch("/api/actions/resolve-threads", { method: "POST" });
        const out = res.ok ? await res.json() as { closed?: number } : null;
        if (out?.closed) await refresh();
      } catch { /* best-effort tidy-up */ }
      // Promises you made in sent mail → actions to confirm. Server-throttled.
      try {
        const res = await fetch("/api/actions/capture-promises", { method: "POST" });
        const out = res.ok ? await res.json() as { created?: number } : null;
        if (out?.created) await refresh();
      } catch { /* best-effort capture */ }
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
  const isTheirs = (a: ActionItem) => isWaitingOnOthers(a, selfName ? [selfName] : []);
  const waitingCount = actions.filter((a) => a.status !== "done" && isTheirs(a)).length;
  const filtered = actions.filter((a) => {
    const matchesSearch =
      !search ||
      a.text.toLowerCase().includes(search.toLowerCase()) ||
      a.owner.toLowerCase().includes(search.toLowerCase());
    if (statusFilter === "waiting") return matchesSearch && a.status !== "done" && isTheirs(a);
    if (isTheirs(a)) return false;
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

  const reviewItems = actions.filter((a) => !!a.needsReview && !isTheirs(a));
  const openCount = overdue.length + dueToday.length + upcoming.length + openNoDue.length + stalled.length;
  const showGrouped = statusFilter === "all" || statusFilter === "open" || statusFilter === "overdue" || statusFilter === "review" || statusFilter === "waiting";

  // ── Category grouping (for "By Category" view) ─────────────────────────────
  const openActions = filtered.filter((a) => a.status !== "done");
  const critical = openActions.filter((a) => a.category === "critical").sort(sortByPriority);
  const adminActs = openActions.filter((a) => a.category === "admin").sort(sortByPriority);
  const personal  = openActions.filter((a) => a.category === "personal").sort(sortByPriority);
  const uncategorized = openActions.filter((a) => !a.category).sort(sortByPriority);
  const decisionNeeded = openActions.filter((a) => a.decisionRequired && !a.linkedDecisionId).sort(sortByPriority);

  // ── Your load (presentation only) ──────────────────────────────────────────
  // Counted from YOUR open commitments with the same rules the groups use, but
  // before search and the status filter — choosing a segment narrows the list
  // without the graphic collapsing to that one segment.
  const weekEndStr = new Date(Date.now() + 7 * 86_400_000).toISOString().split("T")[0];
  const load = countLoad(actions.filter((a) => !isTheirs(a)), todayStr, weekEndStr);
  const loadTotal = load.overdue + load.today + load.week + load.laterDated + load.noDate;
  const nowDate = new Date();
  const longestWait = actions.reduce(
    (m, a) => (a.status !== "done" && isTheirs(a) ? Math.max(m, daysSince(a.createdAt, nowDate)) : m),
    0,
  );
  // Where "later than this week" starts inside Upcoming (which is sorted by date).
  const laterStart = upcoming.findIndex((a) => (a.dueDate ?? "").slice(0, 10) > weekEndStr);

  /** Scroll to a timeline group — used for states that have no filter of their own. */
  function jumpTo(ids: string[]) {
    if (viewMode !== "timeline") setViewMode("timeline");
    if (statusFilter !== "all" && statusFilter !== "open") setStatusFilter("all");
    window.setTimeout(() => {
      const el = ids.map((id) => document.getElementById(id)).find(Boolean);
      if (!el) return;
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    }, 80);
  }

  function showLoad(key: LoadKey) {
    // Overdue has a filter of its own; the other states are groups in the timeline.
    if (key === "overdue") { setStatusFilter("overdue"); return; }
    if (key === "today") { jumpTo(["group-today"]); return; }
    if (key === "week") { jumpTo(["group-upcoming"]); return; }
    const openNoDate = load.noDate - load.stalled;
    jumpTo(
      load.laterDated > 0 ? ["group-later", "group-upcoming", "group-open", "group-stalled"]
      : openNoDate > 0 ? ["group-open", "group-stalled"]
      : ["group-stalled"],
    );
  }

  const eyebrow = loading || fetchError
    ? "Your commitments"
    : `${loadTotal} open · ${waitingCount} waiting on others`;

  return (
    // The Basil identity (2026-10-14). `wire` scopes the cream world to this
    // surface. overflow-clip (not hidden) keeps the Completed panel sticky.
    <div className="wire basil-dots relative min-h-full overflow-clip">
      <span aria-hidden className="pointer-events-none absolute -right-40 -top-56 h-[560px] w-[760px] rounded-full" style={{ background: "radial-gradient(closest-side, rgba(212,185,120,.28), transparent 72%)" }} />
      <div className="relative mx-auto flex w-full max-w-[78rem] flex-col gap-6 px-4 py-6 sm:px-8 sm:py-10">
        <PageHero
          eyebrow={eyebrow}
          title="Commitments"
          subtitle="Commitments from meetings, Slack, and email. Basil can read and add to this list."
          actions={
            <>
              {/* View mode — a segmented control, the active segment navy */}
              <div role="group" aria-label="View" className="hidden min-h-[44px] items-center gap-1 rounded-xl border border-[var(--w-rule-strong)] bg-[var(--w-flimsy)] p-1 sm:inline-flex">
                {([
                  ["timeline", "Timeline"],
                  ["category", "By Category"],
                  ["matrix", "Matrix"],
                ] as const).map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={viewMode === v}
                    onClick={() => setViewMode(v)}
                    className={`inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-colors ${
                      viewMode === v ? "bg-[#10213F] text-[#F6F1E7]" : "text-[color:var(--w-ink)] hover:bg-[var(--w-tray)]"
                    }`}
                  >
                    {v === "matrix" && <LayoutGrid className="h-3.5 w-3.5" aria-hidden />}
                    {label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className={BTN_PRIMARY}
                aria-expanded={form.showForm}
                onClick={() => setForm(f => ({ ...f, showForm: !f.showForm }))}
              >
                <Plus className="h-4 w-4" aria-hidden />
                Add Action
              </button>
            </>
          }
        />

        {/* Add form */}
        {form.showForm && (
          <section aria-label="Add an action" className="basil-rise flex flex-col gap-3 rounded-[20px] border border-[var(--w-rule)] bg-[var(--w-flimsy)] p-5 sm:p-6">
            <Textarea
              placeholder="What needs to be done?"
              value={form.text}
              onChange={(e) => setForm(f => ({ ...f, text: e.target.value }))}
              rows={2}
              aria-label="What needs to be done"
              className="rounded-xl border-[var(--w-rule-strong)] bg-[var(--w-flimsy)] text-[15px]"
            />
            <div className="flex flex-wrap gap-3">
              <Input
                placeholder="Owner"
                value={form.owner}
                onChange={(e) => setForm(f => ({ ...f, owner: e.target.value }))}
                aria-label="Owner"
                className="h-11 min-w-28 flex-1 rounded-xl border-[var(--w-rule-strong)] bg-[var(--w-flimsy)] text-[16px] sm:text-sm"
              />
              <Input
                type="date"
                value={form.due}
                onChange={(e) => setForm(f => ({ ...f, due: e.target.value }))}
                aria-label="Due date"
                className="basil-mono h-11 w-full rounded-xl border-[var(--w-rule-strong)] bg-[var(--w-flimsy)] text-[16px] sm:w-44 sm:text-sm"
              />
              <select
                value={form.priority}
                onChange={(e) => setForm(f => ({ ...f, priority: e.target.value as NonNullable<ActionItem["priority"]> }))}
                aria-label="Priority"
                className="h-11 rounded-xl border border-[var(--w-rule-strong)] bg-[var(--w-flimsy)] px-3 text-[16px] text-[color:var(--w-ink)] sm:text-sm"
              >
                <option value="high">High priority</option>
                <option value="medium">Medium priority</option>
                <option value="low">Low priority</option>
              </select>
              <select
                value={form.source}
                onChange={(e) => setForm(f => ({ ...f, source: e.target.value as ActionItem["source"] }))}
                aria-label="Source"
                className="h-11 rounded-xl border border-[var(--w-rule-strong)] bg-[var(--w-flimsy)] px-3 text-[16px] text-[color:var(--w-ink)] sm:text-sm"
              >
                <option value="manual">Manual</option>
                <option value="meeting">Meeting</option>
                <option value="slack">Slack</option>
                <option value="email">Email</option>
                <option value="chat">Chat</option>
              </select>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={handleAdd} className={BTN_PRIMARY}>
                Save
              </button>
              <button type="button" onClick={clearForm} className={BTN_SECONDARY}>
                Cancel
              </button>
              <DraftSavedIndicator saved={formDraftSaved} className="ml-1" />
            </div>
          </section>
        )}

        {/* Your load — what actually wants you, before the list of everything.
            Folds in the old "needs attention" lead: same counts as the groups
            below, and an outage reads as "cannot tell", never as all clear. */}
        <LoadPanel
          counts={load}
          review={reviewItems.length}
          waiting={waitingCount}
          longestWait={longestWait}
          failed={!!fetchError}
          loading={loading}
          activeFilter={statusFilter}
          onSegment={showLoad}
          onWaiting={() => setStatusFilter("waiting")}
          onReview={() => setStatusFilter("review")}
          onClearFilter={() => setStatusFilter("all")}
          delay={80}
        />

        {/* Filters */}
        <div className="basil-rise flex flex-wrap gap-3" style={{ animationDelay: "160ms" }}>
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--w-ink-soft)]" aria-hidden />
            <Input
              placeholder="Search actions or owner…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search commitments"
              className="h-11 rounded-xl border-[var(--w-rule-strong)] bg-[var(--w-flimsy)] pl-10 text-[15px]"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            aria-label="Filter commitments"
            className="h-11 rounded-xl border border-[var(--w-rule-strong)] bg-[var(--w-flimsy)] px-3 text-[14px] text-[color:var(--w-ink)]"
          >
            <option value="all">All ({actions.length})</option>
            <option value="open">Open ({openCount})</option>
            <option value="done">Done</option>
            <option value="overdue">Overdue</option>
            {waitingCount > 0 && <option value="waiting">Waiting on others ({waitingCount})</option>}
            {reviewItems.length > 0 && (
              <option value="review">Needs Review ({reviewItems.length})</option>
            )}
          </select>
        </div>

        {/* Content + Completed sidebar */}
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-5">
        {/* Content */}
        {loading ? (
          <div className="space-y-3">
            {[1,2,3].map((i) => (
              <div key={i} className="space-y-2 rounded-[20px] border border-[var(--w-rule)] bg-[var(--w-flimsy)] p-5">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            ))}
          </div>
        ) : fetchError ? (
          <div className="rounded-[20px] border border-[var(--w-rule)] bg-[var(--w-flimsy)] px-5 py-2">
            <DataState error={fetchError} onRetry={refresh} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="basil-rise flex flex-col items-center gap-3 rounded-[20px] border border-[var(--w-rule)] bg-[var(--w-flimsy)] p-10 text-center sm:p-12" style={{ animationDelay: "200ms" }}>
            <CheckSquare className="h-10 w-10 text-[color:var(--w-rule-strong)]" aria-hidden />
            <h2 className="basil-serif text-[28px] leading-tight text-[#10213F]">No actions found yet</h2>
            <p className="mx-auto max-w-md text-[14px] leading-relaxed text-[color:var(--w-ink-soft)]">
              Basil extracts commitments from Slack DMs, @-mentions and emails automatically.
              Add one manually, or sync recent activity to let Basil look.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => setForm(f => ({ ...f, showForm: true }))}
                className={BTN_PRIMARY}
              >
                <Plus className="h-4 w-4" aria-hidden />
                Add action
              </button>
              <ActionsSyncButton onSynced={refresh} />
            </div>
          </div>

        ) : viewMode === "category" ? (
          /* ── Category view ──────────────────────────────────────────────── */
          <div className="space-y-5">
            {/* Needs Review — always on top */}
            {reviewItems.length > 0 && (
              <CollapsibleSection
                label="Needs Review"
                items={reviewItems}
                defaultOpen={true}
                delay={200}
                onToggle={toggleDone}
                onReplied={refresh}
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
                items={decisionNeeded}
                defaultOpen={true}
                delay={260}
                onToggle={toggleDone}
                onReplied={refresh}
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
              dot={LOAD_COLOR.overdue}
              items={critical}
              defaultOpen={true}
              delay={320}
              onToggle={toggleDone}
              onReplied={refresh}
              onDelete={handleDelete}
              onConfirmReview={handleConfirmReview}
              onDecisionClick={handleDecisionClick}
              todayStr={todayStr}
            />

            {/* Admin */}
            <CollapsibleSection
              label="Admin & Operations"
              dot={LOAD_COLOR.today}
              items={adminActs}
              defaultOpen={true}
              delay={380}
              onToggle={toggleDone}
              onReplied={refresh}
              onDelete={handleDelete}
              onConfirmReview={handleConfirmReview}
              onDecisionClick={handleDecisionClick}
              todayStr={todayStr}
            />

            {/* Personal */}
            <CollapsibleSection
              label="Personal"
              dot={LOAD_COLOR.week}
              items={personal}
              defaultOpen={true}
              delay={440}
              onToggle={toggleDone}
              onReplied={refresh}
              onDelete={handleDelete}
              onConfirmReview={handleConfirmReview}
              onDecisionClick={handleDecisionClick}
              todayStr={todayStr}
            />

            {/* Uncategorized — collapsed by default */}
            {uncategorized.length > 0 && (
              <CollapsibleSection
                label="Uncategorized"
                dot={LOAD_COLOR.later}
                items={uncategorized}
                defaultOpen={false}
                delay={500}
                onToggle={toggleDone}
                onReplied={refresh}
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
              delay={560}
              onToggle={toggleDone}
              onReplied={refresh}
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
          <div className="space-y-5">
            {/* Needs Review — shown only when items pending */}
            {statusFilter !== "review" && reviewItems.length > 0 && (
              <CollapsibleSection
                id="group-review"
                label="Needs Review"
                items={reviewItems}
                defaultOpen={true}
                delay={200}
                onToggle={toggleDone}
                onReplied={refresh}
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
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={async () => {
                        if (!confirm(`Dismiss all ${filtered.length} review items? This cannot be undone.`)) return;
                        await Promise.all(filtered.map((a) => handleDelete(a.id)));
                      }}
                      className={`${BTN_SECONDARY} hover:text-[color:var(--w-stamp)]`}
                    >
                      Dismiss all ({filtered.length})
                    </button>
                  </div>
                )}
                <CollapsibleSection
                  id="group-review"
                  label="Needs Review"
                  items={filtered}
                  defaultOpen={true}
                  delay={200}
                  onToggle={toggleDone}
                  onReplied={refresh}
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
                  <GroupCard id="group-overdue" label="Overdue" count={overdue.length} dot={LOAD_COLOR.overdue} delay={220}>
                    {overdue.map((a) => (
                      <ActionCard
                        key={a.id}
                        action={a}
                        onToggle={toggleDone}
                        onReplied={refresh}
                        onDelete={handleDelete}
                        onNotes={handleNotes}
                        onConfirmReview={handleConfirmReview}
                        onDecisionClick={handleDecisionClick}
                        todayStr={todayStr}
                        photos={photos}
                      />
                    ))}
                  </GroupCard>
                )}

                {/* Due today */}
                {dueToday.length > 0 && (
                  <GroupCard id="group-today" label="Due Today" count={dueToday.length} dot={LOAD_COLOR.today} delay={290}>
                    {dueToday.map((a) => (
                      <ActionCard
                        key={a.id}
                        action={a}
                        onToggle={toggleDone}
                        onReplied={refresh}
                        onDelete={handleDelete}
                        onNotes={handleNotes}
                        onConfirmReview={handleConfirmReview}
                        onDecisionClick={handleDecisionClick}
                        todayStr={todayStr}
                        photos={photos}
                      />
                    ))}
                  </GroupCard>
                )}

                {/* Upcoming — this week first, then a marker where "later" begins */}
                {upcoming.length > 0 && (
                  <GroupCard id="group-upcoming" label="Upcoming" count={upcoming.length} dot={LOAD_COLOR.week} delay={360}>
                    {upcoming.map((a, i) => (
                      <Fragment key={a.id}>
                        {i === laterStart && (
                          <p
                            id="group-later"
                            className="basil-mono flex scroll-mt-6 items-center gap-2 pb-2 pt-4 text-[11px] uppercase tracking-[0.14em] text-[color:var(--w-ink-soft)]"
                          >
                            <span aria-hidden className="h-2.5 w-2.5 rounded-[3px]" style={swatchStyle(LOAD_COLOR.later)} />
                            Later than this week
                          </p>
                        )}
                        <ActionCard
                          action={a}
                          onToggle={toggleDone}
                          onReplied={refresh}
                          onDelete={handleDelete}
                          onNotes={handleNotes}
                          onConfirmReview={handleConfirmReview}
                          onDecisionClick={handleDecisionClick}
                          todayStr={todayStr}
                          photos={photos}
                        />
                      </Fragment>
                    ))}
                  </GroupCard>
                )}

                {/* Open (no due date) */}
                {openNoDue.length > 0 && (
                  <GroupCard id="group-open" label="Open, no date" count={openNoDue.length} dot={LOAD_COLOR.later} delay={430}>
                    {openNoDue.map((a) => (
                      <ActionCard
                        key={a.id}
                        action={a}
                        onToggle={toggleDone}
                        onReplied={refresh}
                        onDelete={handleDelete}
                        onNotes={handleNotes}
                        onConfirmReview={handleConfirmReview}
                        onDecisionClick={handleDecisionClick}
                        todayStr={todayStr}
                        photos={photos}
                      />
                    ))}
                  </GroupCard>
                )}

                {/* Stalled — collapsed by default */}
                <CollapsibleSection
                  id="group-stalled"
                  label="Stalled"
                  items={stalled}
                  delay={500}
                  archive
                  note="No due date and no movement for weeks. These are not overdue — they are forgotten. Give one a date or delete it."
                  defaultOpen={false}
                  onToggle={toggleDone}
                  onReplied={refresh}
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
                  delay={560}
                  archive
                  note="Completed work, kept for the record."
                  defaultOpen={false}
                  onToggle={toggleDone}
                  onReplied={refresh}
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
          <section className="basil-rise rounded-[20px] border border-[var(--w-rule)] bg-[var(--w-flimsy)] px-4 py-1.5 sm:px-6" style={{ animationDelay: "200ms" }}>
            {filtered.map((a) => (
              <ActionCard
                key={a.id}
                action={a}
                onToggle={toggleDone}
                onReplied={refresh}
                onDelete={handleDelete}
                onNotes={handleNotes}
                onConfirmReview={handleConfirmReview}
                onDecisionClick={handleDecisionClick}
                todayStr={todayStr}
                photos={photos}
              />
            ))}
          </section>
        )}
        </div>{/* end left column */}
        {!loading && done.length > 0 && (
          <CompletedActionsPanel items={done} todayStr={todayStr} />
        )}
        </div>{/* end grid */}
      </div>

      {/* ── Undo toast ──────────────────────────────────────────────────── */}
      {undoEntry && (
        <div role="status" className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl bg-[#10213F] px-4 py-2 text-[14px] font-medium text-[#F6F1E7] shadow-xl animate-in slide-in-from-bottom-2 duration-200">
          <RotateCcw className="h-3.5 w-3.5 shrink-0 text-[#D4B978]" aria-hidden />
          <span className="max-w-[260px] truncate">{undoEntry.label}</span>
          <button
            type="button"
            onClick={handleUndo}
            className="ml-1 inline-flex min-h-[36px] items-center px-1 font-semibold text-[#D4B978] underline-offset-2 hover:underline"
          >
            Undo
          </button>
          <button
            type="button"
            onClick={() => { if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current); setUndoEntry(null); }}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[#F6F1E7] transition-colors hover:bg-[#1A2D50]"
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
