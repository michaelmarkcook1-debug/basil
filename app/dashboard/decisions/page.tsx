"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useDomainSync } from "@/lib/sync/use-domain-sync";
import { usePersistentDraft } from "@/lib/hooks/use-persistent-draft";
import { DraftSavedIndicator } from "@/components/ui/draft-saved-indicator";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";

import { ContactAvatar } from "@/components/ui/contact-avatar";
import { useContactPhotos } from "@/lib/hooks/use-contact-photos";
import {
  Scale,
  Plus,
  Search,
  ChevronDown,
  ChevronRight,
  Link2,
  Lightbulb,
  GitBranch,
  ShieldQuestion,
  X,
  Trash2,
  CheckCircle2,
  Check,
  RefreshCw,
} from "lucide-react";
import { findContactByName } from "@/lib/contacts-lookup";
import { dashboardCache } from "@/lib/dashboard-cache";
import type { Decision } from "@/lib/types/decision";
import { DataState } from "@/components/ui/data-state";
import { EvidencePanel } from "@/components/ui/trust-badge";
import { TrustReviewPrompt } from "@/components/ui/trust-ui";
import { ExplorePanel } from "@/components/explore-panel";

const LEGACY_STORAGE_KEY = "sage-decisions";

interface DecisionFormDraft {
  showForm: boolean;
  text: string;
  title: string;
  by: string;
  date: string;
  context: string;
  rationale: string;
}
function decisionDraftDefault(): DecisionFormDraft {
  return {
    showForm: false,
    text: "",
    title: "",
    by: "",
    date: new Date().toISOString().split("T")[0],
    context: "",
    rationale: "",
  };
}

const SOURCE_LABEL: Record<string, string> = {
  meeting: "Meeting",
  slack: "Slack",
  email: "Email",
  manual: "Manual",
  chat: "Assistant",
};

const SOURCE_COLOR: Record<string, string> = {
  meeting: "bg-signal-info-subtle text-signal-info border-signal-info-border",
  slack:   "bg-signal-warning-subtle text-signal-warning border-signal-warning-border",
  email:   "bg-signal-info-subtle text-signal-info border-signal-info-border",
  manual:  "bg-gray-100 text-gray-600 border-gray-200",
  chat:    "bg-signal-positive-subtle text-signal-positive border-signal-positive-border",
};

function ConfidenceDot({ confidence }: { confidence?: number }) {
  if (confidence === undefined) return null;
  const pct = Math.round(confidence * 100);
  const color =
    pct >= 80 ? "bg-signal-positive" : pct >= 60 ? "bg-signal-warning" : "bg-signal-critical";
  return (
    <span
      title={`Extraction confidence: ${pct}%`}
      className={`inline-block h-2 w-2 rounded-full ${color} shrink-0 mt-1`}
    />
  );
}

function NeedsReviewBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-signal-warning-subtle border border-signal-warning-border px-2 py-0.5 text-xs font-medium text-signal-warning">
      <ShieldQuestion className="h-3 w-3" />
      Needs review
    </span>
  );
}

function DecisionCard({
  d,
  onToggleSuperseded,
  onConfirmReview,
  onDelete,
  onNotes,
  photos = {},
}: {
  d: Decision;
  onToggleSuperseded: (id: string) => void;
  onConfirmReview?: (id: string) => void;
  onDelete?: (id: string) => void;
  onNotes?: (id: string, notes: string) => Promise<void>;
  photos?: Record<string, string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const contact = findContactByName(d.decidedBy);
  const hasDetail =
    d.summary ||
    d.rationale ||
    (d.alternatives && d.alternatives.length > 0) ||
    (d.consequences && d.consequences.length > 0) ||
    (d.stakeholders && d.stakeholders.length > 0) ||
    (d.linkedActionIds && d.linkedActionIds.length > 0);

  const sourceLabel = d.source ? SOURCE_LABEL[d.source] : undefined;
  const sourceCls = d.source ? SOURCE_COLOR[d.source] : "";

  return (
    <Card className={d.status === "superseded" ? "opacity-50" : ""}>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <ConfidenceDot confidence={d.confidence} />

          <div className="flex-1 min-w-0">
            {/* ── Headline row ────────────────────────────────────────── */}
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1">
                {d.title ? (
                  <>
                    <p className={`text-sm font-semibold leading-snug ${d.status === "superseded" ? "line-through" : ""}`}>
                      {d.title}
                    </p>
                    <p className={`text-sm text-muted-foreground mt-0.5 ${d.status === "superseded" ? "line-through" : ""}`}>
                      {d.text}
                    </p>
                  </>
                ) : (
                  <p className={`text-sm font-medium ${d.status === "superseded" ? "line-through" : ""}`}>
                    {d.text}
                  </p>
                )}
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1 shrink-0">
                {hasDetail && (
                  <button
                    onClick={() => setExpanded((v) => !v)}
                    className="text-muted-foreground/60 hover:text-foreground transition-colors p-0.5"
                    title={expanded ? "Collapse" : "Expand details"}
                  >
                    {expanded ? (
                      <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" />
                    )}
                  </button>
                )}
                {/* Mark resolved / reactivate */}
                <button
                  onClick={() => onToggleSuperseded(d.id)}
                  className={`p-0.5 transition-colors ${
                    d.status === "active"
                      ? "text-muted-foreground/50 hover:text-signal-positive"
                      : "text-signal-positive hover:text-muted-foreground"
                  }`}
                  title={d.status === "active" ? "Mark resolved" : "Reactivate"}
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                </button>
                {/* Delete — two-step confirmation */}
                {onDelete && (
                  confirmingDelete ? (
                    <div className="flex items-center gap-1 ml-1">
                      <span className="text-xs text-destructive font-medium">Delete?</span>
                      <button
                        onClick={() => { onDelete(d.id); setConfirmingDelete(false); }}
                        className="text-xs font-semibold text-destructive hover:underline"
                      >Yes</button>
                      <button
                        onClick={() => setConfirmingDelete(false)}
                        className="text-xs text-muted-foreground hover:underline"
                      >No</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmingDelete(true)}
                      className="text-muted-foreground/50 hover:text-destructive transition-colors p-0.5"
                      title="Delete decision"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )
                )}
              </div>
            </div>

            {/* ── Meta row ────────────────────────────────────────────── */}
            <div className="flex items-center gap-3 mt-2 flex-wrap">
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
                <span className="text-xs text-muted-foreground">{d.decidedBy}</span>
              </div>
              <span className="text-xs text-muted-foreground">{d.date}</span>
              <Badge
                variant="outline"
                className={
                  d.status === "active"
                    ? "border-signal-positive-border text-signal-positive text-xs h-4 px-1.5"
                    : "text-xs h-4 px-1.5"
                }
              >
                {d.status}
              </Badge>
              {sourceLabel && (
                <Badge
                  variant="outline"
                  className={`text-xs h-4 px-1.5 ${sourceCls}`}
                >
                  {sourceLabel}
                </Badge>
              )}
              {d.linkedActionIds && d.linkedActionIds.length > 0 && (
                <span className="flex items-center gap-0.5 text-xs text-muted-foreground">
                  <Link2 className="h-3 w-3" />
                  {d.linkedActionIds.length} action{d.linkedActionIds.length !== 1 ? "s" : ""}
                </span>
              )}
              {d.needsReview && <NeedsReviewBadge />}
            </div>

            {/* ── Review prompt ────────────────────────────────────────── */}
            {d.needsReview && (
              <TrustReviewPrompt
                artifactType="decision"
                onConfirm={() => onConfirmReview?.(d.id)}
                onDismiss={() => onDelete?.(d.id)}
                className="mt-2"
              />
            )}

            {/* ── Summary (always shown when present, no expand needed) ─ */}
            {d.summary && (
              <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
                {d.summary}
              </p>
            )}

            {/* ── Context (brief source label) ─────────────────────────── */}
            {d.context && !d.summary && (
              <p className="text-xs text-muted-foreground mt-1.5 italic">
                {d.context}
              </p>
            )}

            {/* ── Expanded detail ─────────────────────────────────────── */}
            {expanded && hasDetail && (
              <div className="mt-3 space-y-2.5 border-t pt-3">
                {d.rationale && (
                  <div className="flex gap-2">
                    <Lightbulb className="h-3.5 w-3.5 text-signal-warning mt-0.5 shrink-0" />
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-0.5">Rationale</p>
                      <p className="text-sm">{d.rationale}</p>
                    </div>
                  </div>
                )}

                {d.alternatives && d.alternatives.length > 0 && (
                  <div className="flex gap-2">
                    <GitBranch className="h-3.5 w-3.5 text-signal-info mt-0.5 shrink-0" />
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-0.5">
                        Alternatives considered
                      </p>
                      <ul className="text-sm space-y-0.5">
                        {d.alternatives.map((alt, i) => (
                          <li key={i} className="text-muted-foreground">
                            · {alt}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}

                {d.consequences && d.consequences.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-0.5">
                      Follow-ups / consequences
                    </p>
                    <ul className="text-sm space-y-0.5 ml-1">
                      {d.consequences.map((c, i) => (
                        <li key={i} className="text-muted-foreground">
                          → {c}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {d.stakeholders && d.stakeholders.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-0.5">
                      Stakeholders
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {d.stakeholders.map((s, i) => (
                        <span
                          key={i}
                          className="text-xs bg-muted rounded px-1.5 py-0.5"
                        >
                          {s}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {d.context && d.summary && (
                  <p className="text-xs text-muted-foreground italic">{d.context}</p>
                )}
              </div>
            )}

            {/* Evidence panel — always shown when provenance or confidence is available */}
            {(d.sourceRef || d.additionalSourceRefs?.length || d.confidence !== undefined) && (
              <EvidencePanel
                sourceRef={d.sourceRef}
                additionalSourceRefs={d.additionalSourceRefs}
                confidence={d.confidence}
                context={expanded ? d.context : undefined}
              />
            )}

            {/* Explore further — inline notes */}
            {onNotes && d.status === "active" && (
              <ExplorePanel
                notes={d.notes}
                onSave={(notes) => onNotes(d.id, notes)}
              />
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** Inline sync button — triggers poll-ingest so Basil re-checks recent Slack/Gmail for decisions. */
function SyncButton({ onSynced }: { onSynced?: () => void }) {
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
        // A second refresh ~12 s later catches decisions written by the after() blocks.
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

// ── Resolved decisions sidebar ────────────────────────────────────────────────

function ResolvedDecisionsPanel({ items, todayStr }: { items: Decision[]; todayStr: string }) {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().split("T")[0];

  const grouped = new Map<string, Decision[]>();
  for (const d of [...items].sort((a, b) => {
    const aKey = (a.updatedAt || a.date).split("T")[0];
    const bKey = (b.updatedAt || b.date).split("T")[0];
    return bKey.localeCompare(aKey);
  })) {
    const key = (d.updatedAt || d.date).split("T")[0];
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(d);
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
        <span className="text-sm font-semibold">Resolved</span>
        <span className="text-xs text-muted-foreground">({items.length})</span>
      </div>
      <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
        {dates.map((date) => (
          <div key={date}>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
              {dateLabel(date)}
            </p>
            <div>
              {grouped.get(date)!.map((d) => (
                <div
                  key={d.id}
                  className="flex items-start gap-2 py-1.5 border-b border-border/30 last:border-0"
                >
                  <Check className="h-3 w-3 text-signal-positive mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-muted-foreground leading-snug line-clamp-2">
                      {d.title || d.text}
                    </p>
                    <p className="text-xs text-muted-foreground/60 mt-0.5">{d.decidedBy}</p>
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

export default function DecisionsPage() {
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<Error | null>(null);

  // Batch-fetch headshots for decision owners
  const decisionOwnerEmails = useMemo(() => {
    const emails: string[] = [];
    for (const d of decisions) {
      const c = findContactByName(d.decidedBy);
      if (c?.email) emails.push(c.email.toLowerCase());
    }
    return Array.from(new Set(emails));
  }, [decisions]);
  const photos = useContactPhotos(decisionOwnerEmails);
  const [search, setSearch] = useState("");
  // Form draft — survives tab switches; cleared on save or explicit cancel.
  const { draft: form, setDraft: setForm, clearDraft: clearForm, draftSaved: formDraftSaved } =
    usePersistentDraft<DecisionFormDraft>("draft-decision", { defaultValue: decisionDraftDefault() });
  const migratedRef = useRef(false);
  // sourceActionId — set when navigating from Actions page "Decision needed" badge
  const [sourceActionId, setSourceActionId] = useState<string | null>(null);

  // Read query params once on mount — avoids useSearchParams Suspense requirement
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const fromAction = params.get("fromAction");
    const actionText = params.get("text");
    if (fromAction && actionText) {
      setSourceActionId(fromAction);
      // Open form pre-filled with the action context
      setForm((f) => ({
        ...f,
        showForm: true,
        context: `Action: ${actionText}`,
        date: new Date().toISOString().split("T")[0],
      }));
      // Clean URL without reload so navigating back/forward works cleanly
      const clean = new URL(window.location.href);
      clean.searchParams.delete("fromAction");
      clean.searchParams.delete("text");
      window.history.replaceState(null, "", clean.toString());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = useCallback(async () => {
    // Serve cached data instantly — eliminates blank flash on tab switch
    const cached = dashboardCache.get<Decision[]>("decisions");
    if (cached) { setDecisions(cached); setLoading(false); }
    // Always revalidate from server
    try {
      const res = await fetch("/api/decisions", { cache: "no-store" });
      if (!res.ok) {
        console.error("[basil-fetch]", res.status === 401 ? "auth_error" : "server_error", { route: "/api/decisions", status: res.status, component: "DecisionsPage" });
        if (!cached) setFetchError(new Error(`HTTP ${res.status}`));
        setLoading(false);
        return;
      }
      setFetchError(null);
      const data = await res.json() as { decisions?: Decision[] };
      const fresh: Decision[] = data.decisions || [];
      dashboardCache.set("decisions", fresh);
      setDecisions(fresh);
    } catch (e) {
      console.error("[basil-fetch] network_error", { route: "/api/decisions", component: "DecisionsPage", error: e instanceof Error ? e.message : String(e) });
      if (!cached) setFetchError(e instanceof Error ? e : new Error("Network error"));
    } finally {
      setLoading(false);
    }
  }, []);

  const notify = useDomainSync("decisions", refresh);

  useEffect(() => {
    (async () => {
      if (!migratedRef.current && typeof window !== "undefined") {
        migratedRef.current = true;
        try {
          const raw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
          if (raw) {
            const parsed = JSON.parse(raw) as Decision[];
            if (Array.isArray(parsed) && parsed.length > 0) {
              const res = await fetch("/api/decisions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ import: parsed }),
              });
              // Only remove local data after server confirms receipt.
              // If the import fails, legacy data stays in localStorage for
              // the next page load to retry — prevents silent data loss.
              if (res.ok) {
                window.localStorage.removeItem(LEGACY_STORAGE_KEY);
              }
            } else {
              // Empty or invalid array — nothing to migrate, safe to clear.
              window.localStorage.removeItem(LEGACY_STORAGE_KEY);
            }
          }
        } catch {
          /* ignore */
        }
      }
      await refresh();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Periodic auto-refresh — materialization runs server-side after poll-ingest
  // returns; domain-emit can only fire from the browser. Without this interval
  // newly-materialized decisions never appear when the user is on this page.
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
    const res = await fetch("/api/decisions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: form.text,
        title: form.title || undefined,
        decidedBy: form.by || "Unknown",
        decidedById: findContactByName(form.by)?.id,
        date: form.date,
        context: form.context || undefined,
        rationale: form.rationale || undefined,
        source: "manual",
      }),
    });
    // If this decision was triggered from an action's "Decision needed" badge,
    // mark that action's decisionRequired resolved and store the decision ID.
    if (sourceActionId && res.ok) {
      let decision: { id: string } | undefined;
      try {
        const body = await res.json() as { decision?: { id: string } };
        decision = body.decision;
      } catch (e) {
        console.error("[basil-fetch] json_parse_error", { route: "/api/decisions", component: "DecisionsPage", error: e instanceof Error ? e.message : String(e) });
      }
      if (decision?.id) {
        await fetch(`/api/actions/${sourceActionId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            decisionRequired: false,
            linkedDecisionId: decision.id,
            linkedDecisionIds: [decision.id],
          }),
        });
        setSourceActionId(null);
      }
    }
    clearForm();
    notify();
  }

  async function handleConfirmReview(id: string) {
    // Optimistic update — bust cache before notify() re-renders from it
    const patched = decisions.map((d) =>
      d.id === id ? { ...d, needsReview: false } : d
    );
    setDecisions(patched);
    dashboardCache.set("decisions", patched);

    await fetch(`/api/decisions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ needsReview: false, reviewDismissedAt: new Date().toISOString() }),
    });
    notify();
  }

  async function handleDelete(id: string) {
    // Optimistic removal — remove from local state and cache immediately
    // so notify()'s refresh() doesn't resurrect the item from stale cache
    const filtered = decisions.filter((d) => d.id !== id);
    setDecisions(filtered);
    dashboardCache.set("decisions", filtered);

    await fetch(`/api/decisions/${id}`, { method: "DELETE" });
    notify();
  }

  async function handleNotes(id: string, notes: string) {
    const patched = decisions.map((d) => (d.id === id ? { ...d, notes } : d));
    setDecisions(patched);
    dashboardCache.set("decisions", patched);
    await fetch(`/api/decisions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes }),
    });
  }

  async function toggleSuperseded(id: string) {
    const current = decisions.find((d) => d.id === id);
    if (!current) return;
    const next = current.status === "active" ? "superseded" : "active";

    // Optimistic update
    const patched = decisions.map((d) =>
      d.id === id ? { ...d, status: next as "active" | "superseded" } : d
    );
    setDecisions(patched);
    dashboardCache.set("decisions", patched);

    await fetch(`/api/decisions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    notify();
  }

  const filtered = decisions.filter(
    (d) =>
      !search ||
      d.text.toLowerCase().includes(search.toLowerCase()) ||
      d.title?.toLowerCase().includes(search.toLowerCase()) ||
      d.decidedBy.toLowerCase().includes(search.toLowerCase()) ||
      d.context.toLowerCase().includes(search.toLowerCase()) ||
      d.rationale?.toLowerCase().includes(search.toLowerCase()) ||
      d.stakeholders?.some((s) => s.toLowerCase().includes(search.toLowerCase()))
  );

  const active = filtered.filter((d) => d.status === "active");
  const reviewDecisions = active.filter((d) => !!d.needsReview);
  const confirmedDecisions = active.filter((d) => !d.needsReview);
  const superseded = filtered.filter((d) => d.status === "superseded");

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Scale className="h-6 w-6 text-gold" />
            Decision Log
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Decisions tracked across meetings, Slack, email, and assistant conversations.
            Dot colour = extraction confidence (green = high, yellow = medium).
          </p>
        </div>
        <Button
          size="sm"
          className="bg-[oklch(0.22_0.05_250)] hover:bg-[oklch(0.28_0.06_250)] text-white gap-1.5"
          onClick={() => setForm(f => ({ ...f, showForm: !f.showForm }))}
        >
          <Plus className="h-3.5 w-3.5" />
          Log Decision
        </Button>
      </header>

      {form.showForm && (
        <Card className="border-gold/30">
          <CardContent className="p-4 space-y-3">
            {/* Context banner when arriving from Actions page */}
            {sourceActionId && (
              <div className="flex items-start gap-2 rounded-lg bg-signal-info-subtle border border-signal-info-border px-3 py-2 text-[12px] text-signal-info">
                <GitBranch className="h-3.5 w-3.5 mt-0.5 shrink-0 text-signal-info" />
                <span>Logging a decision from your Actions list. Once saved, the action will be marked resolved.</span>
              </div>
            )}
            <Input
              placeholder="Short headline (optional, e.g. 'Adopt REST API')"
              value={form.title}
              onChange={(e) => setForm(f => ({ ...f, title: e.target.value }))}
            />
            <Textarea
              placeholder="What was decided? (full statement)"
              value={form.text}
              onChange={(e) => setForm(f => ({ ...f, text: e.target.value }))}
              rows={2}
            />
            <div className="flex gap-3">
              <Input
                placeholder="Decided by"
                value={form.by}
                onChange={(e) => setForm(f => ({ ...f, by: e.target.value }))}
                className="flex-1"
              />
              <Input
                type="date"
                value={form.date}
                onChange={(e) => setForm(f => ({ ...f, date: e.target.value }))}
                className="w-40"
              />
            </div>
            <Input
              placeholder="Context / source (e.g. 'Slack #ap-launch', 'Board call')"
              value={form.context}
              onChange={(e) => setForm(f => ({ ...f, context: e.target.value }))}
            />
            <Textarea
              placeholder="Rationale — why was this decided? (optional)"
              value={form.rationale}
              onChange={(e) => setForm(f => ({ ...f, rationale: e.target.value }))}
              rows={2}
            />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={handleAdd}
                className="bg-gold text-[oklch(0.18_0.04_250)] hover:bg-[oklch(0.78_0.12_85)]"
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

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          placeholder="Search decisions, rationale, stakeholders…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* ── Content + Resolved sidebar ──────────────────────────────────────── */}
      <div className="grid lg:grid-cols-[1fr_280px] gap-6 items-start">
      <div className="min-w-0 space-y-4">

      {/* ── Needs Review decisions ──────────────────────────────────────────── */}
      {reviewDecisions.length > 0 && (
        <div className="space-y-3 rounded-lg border border-signal-warning-border bg-signal-warning-subtle p-3">
          <div className="flex items-center gap-2">
            <ShieldQuestion className="h-3.5 w-3.5 text-signal-warning" />
            <span className="text-xs font-semibold uppercase tracking-wide text-signal-warning">
              Needs Review · {reviewDecisions.length}
            </span>
          </div>
          {reviewDecisions.map((d) => (
            <DecisionCard
              key={d.id}
              d={d}
              onToggleSuperseded={toggleSuperseded}
              onConfirmReview={handleConfirmReview}
              onDelete={handleDelete}
              onNotes={handleNotes}
              photos={photos}
            />
          ))}
        </div>
      )}

      {/* ── Active decisions ────────────────────────────────────────────────── */}
      <div className="space-y-3">
        {loading ? (
          <>
            {[1,2,3].map((i) => (
              <Card key={i}>
                <CardContent className="py-4 space-y-2">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-1/2" />
                </CardContent>
              </Card>
            ))}
          </>
        ) : fetchError ? (
          <Card>
            <CardContent className="py-2">
              <DataState error={fetchError} onRetry={refresh} />
            </CardContent>
          </Card>
        ) : active.length === 0 && !search ? (
          <div className="rounded-2xl basil-card p-12 text-center space-y-3">
            <Scale className="h-12 w-12 mx-auto text-muted-foreground/30" />
            <h2 className="text-xl font-semibold">No decisions found yet</h2>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              Basil extracts decisions from Slack DMs, @-mentions and emails automatically.
              Log one manually, or sync recent activity to let Basil look.
            </p>
            <div className="flex items-center justify-center gap-3 flex-wrap">
              <button
                onClick={() => setForm(f => ({ ...f, showForm: true }))}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[oklch(0.22_0.05_250)] text-white text-sm font-semibold px-4 py-2 hover:bg-[oklch(0.28_0.06_250)] transition"
              >
                <Plus className="h-4 w-4" />
                Log decision
              </button>
              <SyncButton onSynced={refresh} />
            </div>
          </div>
        ) : null}
        {!loading && active.length === 0 && search && (
          <Card>
            <CardContent className="py-6 text-center text-muted-foreground text-sm">
              No decisions match &ldquo;{search}&rdquo;.
            </CardContent>
          </Card>
        )}
        {confirmedDecisions.map((d) => (
          <DecisionCard key={d.id} d={d} onToggleSuperseded={toggleSuperseded} onDelete={handleDelete} onNotes={handleNotes} photos={photos} />
        ))}
      </div>

      </div>{/* end left column */}
      {!loading && superseded.length > 0 && (
        <ResolvedDecisionsPanel
          items={superseded}
          todayStr={new Date().toISOString().split("T")[0]}
        />
      )}
      </div>{/* end grid */}
    </div>
  );
}
