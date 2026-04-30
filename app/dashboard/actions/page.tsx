"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useDomainSync } from "@/lib/sync/use-domain-sync";
import { useDraft } from "@/lib/hooks/use-draft";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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
} from "lucide-react";
import { findContactByName } from "@/lib/contacts-lookup";
import { isActionStalled } from "@/lib/actions/utils";
import { dashboardCache } from "@/lib/dashboard-cache";
import type { ActionItem } from "@/lib/types/action";

const LEGACY_STORAGE_KEY = "sage-actions";

// Draft key — persists unsaved form input across tab switches / navigation.
const ACTION_DRAFT_KEY = "basil-draft-action";
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
  todayStr,
}: {
  action: ActionItem;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onConfirmReview?: (id: string) => void;
  todayStr: string;
}) {
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
                <Avatar className="h-4 w-4">
                  <AvatarFallback className={`text-[11px] text-white ${contact.color}`}>
                    {contact.initials}
                  </AvatarFallback>
                </Avatar>
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
            <ConfidenceDot confidence={action.confidence} />
            {action.needsReview && <NeedsReviewBadge />}

            {/* Linked decisions */}
            {action.linkedDecisionIds && action.linkedDecisionIds.length > 0 && (
              <span className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground">
                <Link2 className="h-3 w-3" />
                {action.linkedDecisionIds.length}
              </span>
            )}
          </div>

          {/* Review controls — confirm keeps it, dismiss removes it */}
          {action.needsReview && (
            <div className="flex items-center gap-2 mt-2 pt-2 border-t border-amber-100">
              <span className="text-[11px] text-amber-700">Basil extracted this — looks right?</span>
              <button
                onClick={() => onConfirmReview?.(action.id)}
                className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium bg-emerald-50 text-emerald-700 hover:bg-emerald-100 transition-colors border border-emerald-200"
                title="Confirm — trust this action"
              >
                <ThumbsUp className="h-2.5 w-2.5" />
                Confirm
              </button>
              <button
                onClick={() => onDelete(action.id)}
                className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium bg-red-50 text-red-600 hover:bg-red-100 transition-colors border border-red-200"
                title="Dismiss — remove this action"
              >
                <X className="h-2.5 w-2.5" />
                Dismiss
              </button>
            </div>
          )}
        </div>

        {/* Delete */}
        <button
          onClick={() => onDelete(action.id)}
          className="text-muted-foreground/50 hover:text-destructive transition-colors"
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
  todayStr,
}: {
  label: string;
  accent?: string;
  items: ActionItem[];
  defaultOpen?: boolean;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onConfirmReview?: (id: string) => void;
  todayStr: string;
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
              todayStr={todayStr}
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

// ── Page ───────────────────────────────────────────────────────────────────────

export default function ActionsPage() {
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  // Form draft — survives tab switches; cleared on save or explicit cancel.
  const [form, setForm, clearForm] = useDraft<ActionFormDraft>(ACTION_DRAFT_KEY, ACTION_DRAFT_DEFAULT);
  const migratedRef = useRef(false);

  const refresh = useCallback(async () => {
    // Serve cached data instantly — eliminates blank flash on tab switch
    const cached = dashboardCache.get<ActionItem[]>("actions");
    if (cached) setActions(cached);
    // Always revalidate from server
    const res = await fetch("/api/actions", { cache: "no-store" });
    if (!res.ok) return; // don't clear UI on server error — keep showing cached/current state
    const data = await res.json() as { actions?: ActionItem[] };
    const fresh: ActionItem[] = data.actions ?? [];
    dashboardCache.set("actions", fresh);
    setActions(fresh);
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
  }, []);

  // Periodic auto-refresh — background materialization (email/Slack classify → createAction)
  // runs server-side after poll-ingest returns; domain-emit can only fire from the browser
  // (BroadcastChannel). If the user is on this page rather than the main dashboard where
  // BasilWatching triggers emits, new actions would never appear without this interval.
  useEffect(() => {
    const interval = setInterval(() => { void refresh(); }, 45_000);
    return () => clearInterval(interval);
  }, [refresh]);

  async function handleAdd() {
    if (!form.text.trim()) return;
    await fetch("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: form.text,
        owner: form.owner || "Michael Cook",
        ownerId: findContactByName(form.owner)?.id,
        dueDate: form.due || undefined,
        source: form.source,
        priority: form.priority,
      }),
    });
    clearForm();
    notify();
  }

  async function toggleDone(id: string) {
    const current = actions.find((a) => a.id === id);
    if (!current) return;
    const next = current.status === "done" ? "open" : "done";
    await fetch(`/api/actions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    notify();
  }

  async function handleDelete(id: string) {
    // Optimistic: remove from UI and cache immediately — no flash / accidental restore
    setActions((prev) => {
      const next = prev.filter((a) => a.id !== id);
      dashboardCache.set("actions", next);
      return next;
    });
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
  }

  const todayStr = new Date().toISOString().split("T")[0];

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

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-4xl">
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
        <Button
          size="sm"
          className="bg-[oklch(0.22_0.05_250)] hover:bg-[oklch(0.28_0.06_250)] text-white gap-1.5"
          onClick={() => setForm(f => ({ ...f, showForm: !f.showForm }))}
        >
          <Plus className="h-3.5 w-3.5" />
          Add Action
        </Button>
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
            <div className="flex gap-2">
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

      {/* Content */}
      {filtered.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No actions found.
          </CardContent>
        </Card>
      ) : showGrouped ? (
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
              todayStr={todayStr}
            />
          )}
          {statusFilter === "review" && (
            <CollapsibleSection
              label="Needs Review"
              accent="text-amber-600"
              items={filtered}
              defaultOpen={true}
              onToggle={toggleDone}
              onDelete={handleDelete}
              onConfirmReview={handleConfirmReview}
              todayStr={todayStr}
            />
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
                        todayStr={todayStr}
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
                        todayStr={todayStr}
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
                        todayStr={todayStr}
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
                        todayStr={todayStr}
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
                todayStr={todayStr}
              />

              {/* Done — collapsed by default */}
              <CollapsibleSection
                label="Done"
                items={done}
                defaultOpen={false}
                onToggle={toggleDone}
                onDelete={handleDelete}
                todayStr={todayStr}
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
              todayStr={todayStr}
            />
          ))}
        </div>
      )}
    </div>
  );
}
