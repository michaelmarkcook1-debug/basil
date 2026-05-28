"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useDomainSync } from "@/lib/sync/use-domain-sync";
// useDraft kept for any legacy callers; actions now uses usePersistentDraft
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
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
} from "lucide-react";
import { useRouter } from "next/navigation";
import { findContactByName } from "@/lib/contacts-lookup";
import { isActionStalled } from "@/lib/actions/utils";
import { dashboardCache } from "@/lib/dashboard-cache";
import type { ActionItem, ActionCategory } from "@/lib/types/action";
import { DataState } from "@/components/ui/data-state";
import { usePersistentDraft } from "@/lib/hooks/use-persistent-draft";
import { DraftSavedIndicator } from "@/components/ui/draft-saved-indicator";
import { EvidencePanel } from "@/components/ui/trust-badge";
import { TrustReviewPrompt } from "@/components/ui/trust-ui";

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
    high: "bg-red-100 text-red-700 border-red-200",
    medium: "bg-amber-100 text-amber-700 border-amber-200",
    low: "bg-slate-100 text-slate-600 border-slate-200",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-1.5 py-0 text-[11px] font-medium ${styles[priority]}`}
    >
      {priority}
    </span>
  );
}

function ConfidenceDot({ confidence }: { confidence?: number }) {
  if (confidence === undefined) return null;
  const pct = Math.round(confidence * 100);
  const color =
    pct >= 80 ? "bg-emerald-500" : pct >= 60 ? "bg-amber-400" : "bg-red-400";
  return (
    <span
      className={`inline-block h-1.5 w-1.5 rounded-full ${color} shrink-0`}
      title={`${pct}% confidence`}
    />
  );
}

function SourceBadge({ source }: { source: ActionItem["source"] }) {
  const styles: Record<ActionItem["source"], string> = {
    meeting: "bg-purple-100 text-purple-700",
    slack:   "bg-green-100 text-green-700",
    email:   "bg-blue-100 text-blue-700",
    manual:  "bg-slate-100 text-slate-600",
    chat:    "bg-indigo-100 text-indigo-700",
    linear:  "bg-violet-100 text-violet-700",
  };
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0 text-[11px] font-medium ${styles[source]}`}
    >
      {source}
    </span>
  );
}

/** Amber pill shown on actions that need user confirmation before being trusted. */
function NeedsReviewBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-1.5 py-0 text-[11px] font-medium text-amber-700">
      <ShieldQuestion className="h-2.5 w-2.5" />
      Review
    </span>
  );
}

/** Compact category chip. */
function CategoryChip({ category }: { category?: ActionCategory }) {
  if (!category) return null;
  const styles: Record<ActionCategory, { cls: string; label: string; Icon: React.ComponentType<{ className?: string }> }> = {
    critical: { cls: "bg-red-50 text-red-700 border-red-200",    label: "Critical", Icon: Briefcase },
    admin:    { cls: "bg-sky-50  text-sky-700  border-sky-200",   label: "Admin",    Icon: ClipboardList },
    personal: { cls: "bg-teal-50 text-teal-700 border-teal-200", label: "Personal", Icon: User },
  };
  const { cls, label, Icon } = styles[category];
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0 text-[11px] font-medium ${cls}`}>
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
      className="inline-flex items-center gap-1 rounded-full border border-violet-300 bg-violet-50 px-1.5 py-0 text-[11px] font-medium text-violet-700 hover:bg-violet-100 transition-colors cursor-pointer"
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
  todayStr,
  photos = {},
}: {
  action: ActionItem;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onConfirmReview?: (id: string) => void;
  onDecisionClick?: (action: ActionItem) => void;
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
    <Card className={action.status === "done" ? "opacity-55" : ""}>
      <CardContent className="p-4 flex items-start gap-3">
        {/* Checkbox */}
        <button
          onClick={() => onToggle(action.id)}
          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors ${
            action.status === "done"
              ? "bg-emerald-500 border-emerald-500 text-white"
              : "border-border hover:border-[oklch(0.72_0.15_85)]"
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
            {/* Owner */}
            <div className="flex items-center gap-1.5">
              {contact && (
                <ContactAvatar
                  initials={contact.initials}
                  color={contact.color}
                  photoUrl={photos[contact.email?.toLowerCase() ?? ""]}
                  className="h-4 w-4"
                  fallbackClassName="text-[11px]"
                />
              )}
              <span className="text-xs text-muted-foreground">{action.owner}</span>
            </div>

            {/* Due date */}
            {action.dueDate && (
              <span
                className={`text-xs font-medium ${
                  isOverdue
                    ? "text-red-500"
                    : isDueToday
                    ? "text-amber-500"
                    : "text-muted-foreground"
                }`}
              >
                Due {action.dueDate}
              </span>
            )}

            {/* Stalled indicator */}
            {stalled && (
              <span className="inline-flex items-center gap-1 text-[11px] text-amber-600 font-medium">
                <Clock className="h-3 w-3" />
                Stalled
              </span>
            )}

            <PriorityBadge priority={action.priority} />
            <SourceBadge source={action.source} />
            <CategoryChip category={action.category} />
            <ConfidenceDot confidence={action.confidence} />
            {action.needsReview && <NeedsReviewBadge />}

            {/* Decision needed — click-through to Decisions */}
            {action.decisionRequired && !action.linkedDecisionId && (
              <DecisionRequiredBadge onClick={() => onDecisionClick?.(action)} />
            )}

            {/* Linked decisions */}
            {action.linkedDecisionIds && action.linkedDecisionIds.length > 0 && (
              <span className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground">
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
        </div>

        {/* Delete — single click, undo toast gives 5 s to recover */}
        <button
          onClick={() => onDelete(action.id)}
          className="text-muted-foreground/50 hover:text-destructive transition-colors shrink-0"
          title="Delete action"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </CardContent>
    </Card>
  );
}

// ── Collapsible section wrapper ────────────────────────────────────────────────

function CollapsibleSection({
  label,
  accent,
  items,
  defaultOpen = true,
  onToggle,
  onDelete,
  onConfirmReview,
  onDecisionClick,
  todayStr,
  photos = {},
}: {
  label: string;
  accent?: string;
  items: ActionItem[];
  defaultOpen?: boolean;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onConfirmReview?: (id: string) => void;
  onDecisionClick?: (action: ActionItem) => void;
  todayStr: string;
  photos?: Record<string, string>;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (items.length === 0) return null;

  return (
    <div>
      <button
        className="flex items-center gap-2 w-full mb-2 group"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        )}
        <span
          className={`text-xs font-semibold uppercase tracking-wider ${accent ?? "text-muted-foreground"}`}
        >
          {label}
        </span>
        <span className="text-xs text-muted-foreground">({items.length})</span>
        <div className="flex-1 border-t border-border/50" />
      </button>
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
      className="inline-flex items-center gap-2 text-sm text-[oklch(0.58_0.15_85)] hover:underline disabled:opacity-50"
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
        <CheckCircle2 className="h-4 w-4 text-emerald-500" />
        <span className="text-sm font-semibold">Completed</span>
        <span className="text-xs text-muted-foreground">({items.length})</span>
      </div>
      <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
        {dates.map((date) => (
          <div key={date}>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
              {dateLabel(date)}
            </p>
            <div>
              {grouped.get(date)!.map((a) => (
                <div
                  key={a.id}
                  className="flex items-start gap-2 py-1.5 border-b border-border/30 last:border-0"
                >
                  <Check className="h-3 w-3 text-emerald-500 mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-muted-foreground leading-snug line-clamp-2">{a.text}</p>
                    {a.owner && (
                      <p className="text-[10px] text-muted-foreground/60 mt-0.5">{a.owner}</p>
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

// ── Page ───────────────────────────────────────────────────────────────────────

export default function ActionsPage() {
  const router = useRouter();
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<Error | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  // "timeline" (default) vs "category" view
  const [viewMode, setViewMode] = useState<"timeline" | "category">("timeline");
  // Form draft — survives tab switches; cleared on save or explicit cancel.
  const { draft: form, setDraft: setForm, clearDraft: clearForm, draftSaved: formDraftSaved } =
    usePersistentDraft<ActionFormDraft>("draft-action", { defaultValue: ACTION_DRAFT_DEFAULT });
  const migratedRef = useRef(false);

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
              await fetch("/api/actions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ import: parsed }),
              });
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
    const interval = setInterval(() => { void refresh(); }, 45_000);
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
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <ListChecks className="h-6 w-6 text-[oklch(0.72_0.15_85)]" />
            Action Tracker
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Commitments from meetings, Slack, and email. Basil can read and add to this list.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* View mode toggle */}
          <div className="hidden sm:flex rounded-lg border border-border overflow-hidden text-xs">
            <button
              className={`px-3 py-1.5 font-medium transition-colors ${viewMode === "timeline" ? "bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)]" : "bg-background text-muted-foreground hover:text-foreground"}`}
              onClick={() => setViewMode("timeline")}
            >Timeline</button>
            <button
              className={`px-3 py-1.5 font-medium transition-colors ${viewMode === "category" ? "bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)]" : "bg-background text-muted-foreground hover:text-foreground"}`}
              onClick={() => setViewMode("category")}
            >By Category</button>
          </div>
          <Button
            size="sm"
            className="bg-[oklch(0.72_0.15_85)] hover:bg-[oklch(0.78_0.12_85)] text-[oklch(0.18_0.04_250)] gap-1.5"
            onClick={() => setForm(f => ({ ...f, showForm: !f.showForm }))}
          >
            <Plus className="h-3.5 w-3.5" />
            Add Action
          </Button>
        </div>
      </header>

      {/* Add form */}
      {form.showForm && (
        <Card className="border-[oklch(0.72_0.15_85)]/30">
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
                className="bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)] hover:bg-[oklch(0.78_0.12_85)]"
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
              className="inline-flex items-center gap-1.5 rounded-lg bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)] text-sm font-semibold px-4 py-2 hover:brightness-105 transition"
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
              accent="text-amber-600"
              items={reviewItems}
              defaultOpen={true}
              onToggle={toggleDone}
              onDelete={handleDelete}
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
              accent="text-violet-600"
              items={decisionNeeded}
              defaultOpen={true}
              onToggle={toggleDone}
              onDelete={handleDelete}
              onConfirmReview={handleConfirmReview}
              onDecisionClick={handleDecisionClick}
              todayStr={todayStr}
              photos={photos}
            />
          )}

          {/* Critical / role + project */}
          <CollapsibleSection
            label="Critical — Role & Project"
            accent="text-red-600"
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
            accent="text-sky-600"
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
            accent="text-teal-600"
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

      ) : showGrouped ? (
        /* ── Timeline view (default) ──────────────────────────────────── */
        <div className="space-y-6">
          {/* Needs Review — amber section, shown only when items pending */}
          {statusFilter !== "review" && reviewItems.length > 0 && (
            <CollapsibleSection
              label="Needs Review"
              accent="text-amber-600"
              items={reviewItems}
              defaultOpen={true}
              onToggle={toggleDone}
              onDelete={handleDelete}
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
                accent="text-amber-600"
                items={filtered}
                defaultOpen={true}
                onToggle={toggleDone}
                onDelete={handleDelete}
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
                  <SectionHeading label="Overdue" count={overdue.length} accent="text-red-500" />
                  <div className="space-y-2">
                    {overdue.map((a) => (
                      <ActionCard
                        key={a.id}
                        action={a}
                        onToggle={toggleDone}
                        onDelete={handleDelete}
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
                  <SectionHeading label="Due Today" count={dueToday.length} accent="text-amber-500" />
                  <div className="space-y-2">
                    {dueToday.map((a) => (
                      <ActionCard
                        key={a.id}
                        action={a}
                        onToggle={toggleDone}
                        onDelete={handleDelete}
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
                accent="text-amber-500"
                items={stalled}
                defaultOpen={false}
                onToggle={toggleDone}
                onDelete={handleDelete}
                onConfirmReview={handleConfirmReview}
                onDecisionClick={handleDecisionClick}
                todayStr={todayStr}
                photos={photos}
              />

              {/* Done — collapsed by default */}
              <CollapsibleSection
                label="Done"
                items={done}
                defaultOpen={false}
                onToggle={toggleDone}
                onDelete={handleDelete}
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
            className="ml-1 text-[oklch(0.72_0.15_85)] hover:text-[oklch(0.80_0.15_85)] font-semibold transition-colors"
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
