"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { emitChange } from "@/lib/sync/channel";
import {
  X,
  Mail,
  MessageSquare,
  Calendar,
  FileText,
  Sparkles,
  Video,
  Check,
  XCircle,
  AlertTriangle,
  Clock,
  CheckCircle2,
  Tag,
  Loader2,
  AlertCircle,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { BasilEvent } from "@/lib/events/types";

interface Props {
  open: boolean;
  onClose: () => void;
  events: BasilEvent[];
  focusedId: string | null;
  onRefresh: () => void | Promise<void>;
}

const SOURCE_ICON: Record<BasilEvent["source"], typeof Mail> = {
  email: Mail,
  slack: MessageSquare,
  calendar: Calendar,
  drive: FileText,
  manual: Sparkles,
  zoom_email: Video,
};

const DISPOSITION_STYLE: Record<
  BasilEvent["disposition"],
  { label: string; bg: string; ring: string; text: string; Icon: typeof CheckCircle2 }
> = {
  notify: {
    label: "Heads up",
    bg: "bg-rose-500/[0.06]",
    ring: "ring-rose-500/40",
    text: "text-rose-600",
    Icon: AlertTriangle,
  },
  draft: {
    label: "Needs approval",
    bg: "bg-[oklch(0.72_0.15_85)]/[0.06]",
    ring: "ring-[oklch(0.72_0.15_85)]/50",
    text: "text-[oklch(0.58_0.15_85)]",
    Icon: Clock,
  },
  auto: {
    label: "Handled",
    bg: "bg-emerald-500/[0.05]",
    ring: "ring-emerald-500/40",
    text: "text-emerald-600",
    Icon: CheckCircle2,
  },
};

export function ApprovalPanel({
  open,
  onClose,
  events,
  focusedId,
  onRefresh,
}: Props) {
  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const active = useMemo(
    () =>
      events.filter(
        (e) =>
          e.status === "pending" ||
          (e.disposition === "notify" && e.status !== "acknowledged")
      ),
    [events]
  );

  // Auto-select focused item; on desktop (sm+) auto-select first item.
  // Don't include selectedId in deps — user clearing selection (back button) should not re-trigger.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const isDesktop = typeof window !== "undefined" && window.innerWidth >= 640;
  useEffect(() => {
    if (focusedId) setSelectedId(focusedId);
    else if (isDesktop && active.length > 0 && !selectedId) setSelectedId(active[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedId, active]);

  const selected =
    events.find((e) => e.id === selectedId) ?? active[0] ?? null;

  const handleDone = async () => {
    setSelectedId(null);
    await onRefresh();
  };

  return (
    <>
      {/* Overlay */}
      <div
        aria-hidden={!open}
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-40 bg-[oklch(0.12_0.03_250)]/50 backdrop-blur-sm transition-opacity",
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        )}
      />

      {/* Panel */}
      <aside
        aria-hidden={!open}
        role="dialog"
        aria-label="Basil approval queue"
        className={cn(
          "fixed inset-y-0 right-0 z-50 w-full sm:w-[640px] md:w-[720px] bg-background border-l border-border shadow-2xl flex flex-col transition-transform duration-200",
          open ? "translate-x-0" : "translate-x-full"
        )}
      >
        <header className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <h2 className="text-base font-semibold flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-[oklch(0.72_0.15_85)]" />
              Basil queue
            </h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              {active.length} waiting · press{" "}
              <kbd className="px-1.5 py-0.5 rounded bg-muted text-[12px] font-mono">
                esc
              </kbd>{" "}
              to close
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground rounded-md p-1.5 hover:bg-accent/40"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 flex min-h-0">
          {/* List — full width on mobile when nothing selected, narrow sidebar otherwise */}
          <div className={cn(
            "border-r border-border overflow-y-auto shrink-0",
            selectedId
              ? "hidden sm:block sm:w-56"
              : "w-full sm:w-56"
          )}>
            {active.length === 0 ? (
              <div className="p-4 text-xs text-muted-foreground">
                Nothing to review.
              </div>
            ) : (
              <ul className="py-1">
                {active.map((e) => {
                  const ds = DISPOSITION_STYLE[e.disposition];
                  const Icon = SOURCE_ICON[e.source];
                  const isSelected = selectedId === e.id;
                  return (
                    <li key={e.id}>
                      <button
                        onClick={() => setSelectedId(e.id)}
                        className={cn(
                          "w-full text-left px-3 py-2 border-l-2 transition-colors",
                          isSelected
                            ? "bg-accent/50 border-[oklch(0.72_0.15_85)]"
                            : "border-transparent hover:bg-accent/30"
                        )}
                      >
                        <div className="flex items-center gap-1.5">
                          <Icon className="h-3 w-3 text-muted-foreground shrink-0" />
                          <span
                            className={cn(
                              "text-[12px] font-mono uppercase tracking-wider",
                              ds.text
                            )}
                          >
                            {ds.label}
                          </span>
                        </div>
                        <p className="text-xs font-medium truncate mt-1">
                          {e.headline}
                        </p>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Detail */}
          <div className={cn("flex-1 overflow-y-auto flex flex-col", !selectedId && "hidden sm:flex")}>
            {selected ? (
              <>
                {/* Back button — mobile only */}
                <button
                  onClick={() => setSelectedId(null)}
                  className="sm:hidden flex items-center gap-1.5 px-4 py-2.5 text-sm text-muted-foreground border-b border-border hover:text-foreground shrink-0"
                >
                  <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M10 3L5 8l5 5"/>
                  </svg>
                  All items
                </button>
                <div className="flex-1 overflow-y-auto">
                  <EventDetail event={selected} onDone={handleDone} />
                </div>
              </>
            ) : (
              <div className="p-8 text-center text-sm text-muted-foreground">
                <Sparkles className="h-6 w-6 mx-auto mb-2 text-[oklch(0.72_0.15_85)]/60" />
                All caught up. Basil will surface things as they come in.
              </div>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}

// ── Execution state ──────────────────────────────────────────────────────────

type ExecState = "idle" | "executing" | "executed" | "failed";

interface ExecFeedback {
  state: ExecState;
  summary: string;
  error: string;
}

// ── EventDetail ──────────────────────────────────────────────────────────────

function EventDetail({
  event,
  onDone,
}: {
  event: BasilEvent;
  /** Called after execution completes (success/failure/dismiss) so the parent
   *  can clear the selection and refresh the event list. */
  onDone: () => Promise<void>;
}) {
  const ds = DISPOSITION_STYLE[event.disposition];
  const [draftBody, setDraftBody] = useState(event.draft?.body ?? "");
  const [exec, setExec] = useState<ExecFeedback>({
    state: "idle",
    summary: "",
    error: "",
  });
  const [regenerating, setRegenerating] = useState(false);
  const [regenError, setRegenError]     = useState<string | null>(null);
  // The live draft meta (generatedAt + caveat) may be updated by regeneration
  const [liveDraft, setLiveDraft] = useState(event.draft);

  // Reset all local state when the displayed event changes
  useEffect(() => {
    setDraftBody(event.draft?.body ?? "");
    setExec({ state: "idle", summary: "", error: "" });
    setRegenerating(false);
    setRegenError(null);
    setLiveDraft(event.draft);
  }, [event.id, event.draft?.body]);

  // Auto-close after a successful execution
  const autoCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (exec.state === "executed") {
      autoCloseRef.current = setTimeout(() => onDone(), 2200);
    }
    return () => {
      if (autoCloseRef.current) clearTimeout(autoCloseRef.current);
    };
  }, [exec.state, onDone]);

  // ── Approve / Send ─────────────────────────────────────────────────────────
  const handleApprove = async () => {
    setExec({ state: "executing", summary: "", error: "" });
    try {
      const res = await fetch(`/api/events/${event.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "approved", draftBody }),
      });
      const data = (await res.json()) as {
        event?: BasilEvent;
        execution?: { ok: boolean; summary: string; error?: string };
        error?: string;
      };

      if (!res.ok || data.error) {
        setExec({
          state: "failed",
          summary: "",
          error: data.error ?? `Server error ${res.status}`,
        });
        return;
      }

      if (data.execution?.ok) {
        setExec({
          state: "executed",
          summary: data.execution.summary,
          error: "",
        });
        // Broadcast to every other open surface so they refresh without
        // requiring the user to manually navigate away and back.
        emitChange("events");
        if (data.event?.actionId)   emitChange("actions");
        if (data.event?.decisionId) emitChange("decisions");
        if (data.event?.memoryId)   emitChange("memory");
      } else {
        setExec({
          state: "failed",
          summary: "",
          error: data.execution?.error ?? "Execution failed with no details.",
        });
      }
    } catch (e) {
      setExec({
        state: "failed",
        summary: "",
        error: e instanceof Error ? e.message : "Network error",
      });
    }
  };

  // ── Reject / Acknowledge ───────────────────────────────────────────────────
  const handleDismiss = async (status: "rejected" | "acknowledged") => {
    setExec({ state: "executing", summary: "", error: "" });
    try {
      await fetch(`/api/events/${event.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      // Acknowledging a notify alert creates a completed action server-side.
      // Emit so the Actions tab refreshes without a manual page reload.
      if (status === "acknowledged") {
        emitChange("actions");
      }
    } catch {
      // Best-effort — proceed to close even if the request failed
    }
    await onDone();
  };

  // ── Regenerate draft ──────────────────────────────────────────────────────
  const handleRegenerate = async () => {
    setRegenerating(true);
    setRegenError(null);
    try {
      const res = await fetch(`/api/events/${event.id}/draft`, { method: "POST" });
      const data = (await res.json()) as {
        draft?: typeof event.draft;
        error?: string;
        caveat?: string;
      };
      if (!res.ok || data.error) {
        setRegenError(data.error ?? `Server error ${res.status}`);
      } else if (data.draft) {
        setLiveDraft(data.draft);
        setDraftBody(data.draft.body ?? "");
      }
    } catch (e) {
      setRegenError(e instanceof Error ? e.message : "Network error");
    } finally {
      setRegenerating(false);
    }
  };

  // ── Execution overlay states ───────────────────────────────────────────────

  if (exec.state === "executing") {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 p-10 text-center">
        <Loader2 className="h-7 w-7 animate-spin text-[oklch(0.72_0.15_85)]" />
        <p className="text-sm font-medium text-foreground">
          {event.draft?.channel === "email"
            ? "Sending email…"
            : event.draft?.channel === "slack"
            ? "Sending Slack message…"
            : "Executing…"}
        </p>
        <p className="text-xs text-muted-foreground">
          This usually takes a second.
        </p>
      </div>
    );
  }

  if (exec.state === "executed") {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 p-10 text-center">
        <div className="rounded-full bg-emerald-500/10 p-3">
          <CheckCircle2 className="h-7 w-7 text-emerald-600" />
        </div>
        <p className="text-sm font-semibold text-foreground">Done</p>
        <p className="text-sm text-muted-foreground max-w-xs">{exec.summary}</p>
        <p className="text-xs text-muted-foreground mt-1">Closing in a moment…</p>
      </div>
    );
  }

  if (exec.state === "failed") {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 p-10 text-center">
        <div className="rounded-full bg-rose-500/10 p-3">
          <AlertCircle className="h-7 w-7 text-rose-600" />
        </div>
        <p className="text-sm font-semibold text-foreground">Action failed</p>
        <p className="text-sm text-muted-foreground max-w-xs leading-relaxed">
          {exec.error}
        </p>
        <div className="flex gap-2 mt-2">
          <button
            onClick={() => setExec({ state: "idle", summary: "", error: "" })}
            className="text-sm px-3.5 py-2 rounded-md border border-border hover:bg-accent/40 transition"
          >
            Try again
          </button>
          <button
            onClick={onDone}
            className="text-sm px-3.5 py-2 rounded-md bg-muted text-muted-foreground hover:bg-muted/70 transition"
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  // ── Normal (idle) view ─────────────────────────────────────────────────────

  return (
    <div className="p-5 space-y-5">
      {/* Status badge + headline */}
      <div className={cn("rounded-lg ring-1 ring-inset p-4", ds.bg, ds.ring)}>
        <div className="flex items-center gap-2 mb-2">
          <ds.Icon className={cn("h-4 w-4", ds.text)} />
          <span
            className={cn(
              "text-[12px] font-mono uppercase tracking-[0.18em]",
              ds.text
            )}
          >
            {ds.label}
          </span>
          {event.priority === "high" && (
            <span className="ml-1 rounded-sm bg-rose-500/10 text-rose-600 text-[12px] font-mono uppercase tracking-wider px-1.5 py-0.5">
              high priority
            </span>
          )}
        </div>
        <h3 className="text-base font-semibold">{event.headline}</h3>
      </div>

      {/* Why Basil did this */}
      <section>
        <h4 className="text-[12px] font-mono uppercase tracking-[0.18em] text-muted-foreground mb-1.5">
          Why
        </h4>
        <p className="text-sm text-foreground/90">{event.rationale}</p>
      </section>

      {/* Context */}
      <section>
        <h4 className="text-[12px] font-mono uppercase tracking-[0.18em] text-muted-foreground mb-1.5">
          What Basil saw
        </h4>
        <pre className="text-sm whitespace-pre-wrap font-sans bg-muted/40 rounded-lg p-3 border border-border/70 text-foreground/90 leading-relaxed">
          {event.context}
        </pre>
      </section>

      {/* Tags */}
      {event.tags.length > 0 && (
        <section className="flex items-center gap-1.5 flex-wrap">
          <Tag className="h-3 w-3 text-muted-foreground" />
          {event.tags.map((t) => (
            <span
              key={t}
              className="rounded-full bg-muted text-muted-foreground text-[12px] font-mono px-2 py-0.5"
            >
              {t}
            </span>
          ))}
        </section>
      )}

      {/* Draft editor — only for events with an outbound draft */}
      {event.disposition === "draft" && liveDraft && (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-[12px] font-mono uppercase tracking-[0.18em] text-muted-foreground">
              Proposed {liveDraft.channel === "email" ? "email" : "Slack reply"}
            </h4>
            <button
              onClick={handleRegenerate}
              disabled={regenerating}
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50 transition"
              title="Re-generate draft with AI"
            >
              <RefreshCw className={`h-3 w-3 ${regenerating ? "animate-spin" : ""}`} />
              {regenerating ? "Regenerating…" : "Regenerate"}
            </button>
          </div>

          {/* Caveat banner */}
          {liveDraft.caveat && (
            <div className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" />
              <span>{liveDraft.caveat}</span>
            </div>
          )}

          {/* Regen error */}
          {regenError && (
            <div className="flex items-start gap-1.5 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-px" />
              <span>Regeneration failed: {regenError}</span>
            </div>
          )}

          <div className="rounded-lg border border-border bg-background">
            <div className="px-3 py-2 border-b border-border/70 text-xs text-muted-foreground space-y-0.5">
              <div>
                <span className="font-mono text-[12px] uppercase tracking-wider mr-2">
                  To
                </span>
                {liveDraft.to}
              </div>
              {liveDraft.subject && (
                <div>
                  <span className="font-mono text-[12px] uppercase tracking-wider mr-2">
                    Subject
                  </span>
                  {liveDraft.subject}
                </div>
              )}
            </div>

            {/* Loading state — body is empty and hasn't been generated yet */}
            {!draftBody && !liveDraft.generatedAt ? (
              <div className="flex items-center gap-2 px-3 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                Generating draft…
              </div>
            ) : (
              <textarea
                value={draftBody}
                onChange={(e) => setDraftBody(e.target.value)}
                className="w-full resize-y min-h-[140px] px-3 py-2 text-[16px] md:text-sm leading-relaxed bg-transparent focus:outline-none"
                spellCheck
                aria-label="Draft message body"
              />
            )}
          </div>

          <div className="flex items-center justify-between">
            <p className="text-[11px] text-muted-foreground">
              Edit above before sending. Changes are used as-is.
            </p>
            {liveDraft.generatedAt && (
              <p className="text-[11px] text-muted-foreground shrink-0">
                AI draft ·{" "}
                {new Date(liveDraft.generatedAt).toLocaleTimeString("en-GB", {
                  hour: "2-digit",
                  minute: "2-digit",
                  timeZone: "Europe/London",
                })}
              </p>
            )}
          </div>
        </section>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 pt-2 border-t border-border">
        {event.disposition === "draft" ? (
          <>
            <button
              onClick={handleApprove}
              disabled={!draftBody && !liveDraft?.generatedAt}
              className="inline-flex items-center gap-1.5 rounded-md bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)] text-sm font-semibold px-3.5 py-2 hover:brightness-105 transition disabled:opacity-40 disabled:cursor-not-allowed"
              title={!draftBody && !liveDraft?.generatedAt ? "Waiting for AI draft…" : undefined}
            >
              <Check className="h-4 w-4" />
              Send
            </button>
            <button
              onClick={() => handleDismiss("rejected")}
              className="inline-flex items-center gap-1.5 rounded-md border border-border text-sm font-medium px-3.5 py-2 hover:bg-accent/40 transition"
            >
              <XCircle className="h-4 w-4" />
              Reject
            </button>
          </>
        ) : (
          <button
            onClick={() => handleDismiss("acknowledged")}
            className="inline-flex items-center gap-1.5 rounded-md bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)] text-sm font-semibold px-3.5 py-2 hover:brightness-105 transition"
          >
            <Check className="h-4 w-4" />
            Got it
          </button>
        )}
        <span className="text-[12px] text-muted-foreground ml-auto">
          {new Date(event.createdAt).toLocaleString("en-GB", {
            timeZone: "Europe/London",
          })}
        </span>
      </div>
    </div>
  );
}
