"use client";

import { useEffect, useMemo, useState } from "react";
import {
  X,
  Mail,
  MessageSquare,
  Calendar,
  FileText,
  Sparkles,
  Check,
  XCircle,
  AlertTriangle,
  Clock,
  CheckCircle2,
  Tag,
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

  // Auto-select focused → otherwise first active
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (focusedId) setSelectedId(focusedId);
    else if (active.length > 0 && !selectedId) setSelectedId(active[0].id);
  }, [focusedId, active, selectedId]);

  const selected =
    events.find((e) => e.id === selectedId) ?? active[0] ?? null;

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
          {/* List */}
          <div className="w-56 border-r border-border overflow-y-auto shrink-0">
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
          <div className="flex-1 overflow-y-auto">
            {selected ? (
              <EventDetail
                event={selected}
                onAction={async (status) => {
                  await fetch(`/api/events/${selected.id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ status }),
                  });
                  setSelectedId(null);
                  await onRefresh();
                }}
              />
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

function EventDetail({
  event,
  onAction,
}: {
  event: BasilEvent;
  onAction: (status: "approved" | "rejected" | "acknowledged") => Promise<void>;
}) {
  const ds = DISPOSITION_STYLE[event.disposition];
  const [draftBody, setDraftBody] = useState(event.draft?.body ?? "");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setDraftBody(event.draft?.body ?? "");
  }, [event.id, event.draft?.body]);

  const act = async (status: "approved" | "rejected" | "acknowledged") => {
    setSubmitting(true);
    try {
      await onAction(status);
    } finally {
      setSubmitting(false);
    }
  };

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

      {/* Draft editor */}
      {event.disposition === "draft" && event.draft && (
        <section>
          <h4 className="text-[12px] font-mono uppercase tracking-[0.18em] text-muted-foreground mb-1.5">
            Proposed {event.draft.channel === "email" ? "email" : "Slack reply"}
          </h4>
          <div className="rounded-lg border border-border bg-background">
            <div className="px-3 py-2 border-b border-border/70 text-xs text-muted-foreground space-y-0.5">
              <div>
                <span className="font-mono text-[12px] uppercase tracking-wider mr-2">
                  To
                </span>
                {event.draft.to}
              </div>
              {event.draft.subject && (
                <div>
                  <span className="font-mono text-[12px] uppercase tracking-wider mr-2">
                    Subject
                  </span>
                  {event.draft.subject}
                </div>
              )}
            </div>
            <textarea
              value={draftBody}
              onChange={(e) => setDraftBody(e.target.value)}
              className="w-full resize-y min-h-[140px] px-3 py-2 text-sm leading-relaxed bg-transparent focus:outline-none"
              spellCheck
            />
          </div>
        </section>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 pt-2 border-t border-border">
        {event.disposition === "draft" ? (
          <>
            <button
              disabled={submitting}
              onClick={() => act("approved")}
              className="inline-flex items-center gap-1.5 rounded-md bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)] text-sm font-semibold px-3.5 py-2 hover:brightness-105 transition disabled:opacity-50"
            >
              <Check className="h-4 w-4" />
              Send
            </button>
            <button
              disabled={submitting}
              onClick={() => act("rejected")}
              className="inline-flex items-center gap-1.5 rounded-md border border-border text-sm font-medium px-3.5 py-2 hover:bg-accent/40 transition disabled:opacity-50"
            >
              <XCircle className="h-4 w-4" />
              Reject
            </button>
          </>
        ) : (
          <button
            disabled={submitting}
            onClick={() => act("acknowledged")}
            className="inline-flex items-center gap-1.5 rounded-md bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)] text-sm font-semibold px-3.5 py-2 hover:brightness-105 transition disabled:opacity-50"
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
