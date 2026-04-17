"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Eye,
  Mail,
  MessageSquare,
  Calendar,
  FileText,
  Sparkles,
  AlertTriangle,
  CheckCircle2,
  Clock,
  ArrowRight,
  RefreshCw,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { BasilEvent } from "@/lib/events/types";
import { ApprovalPanel } from "./approval-panel";

const SOURCE_ICON: Record<BasilEvent["source"], typeof Mail> = {
  email: Mail,
  slack: MessageSquare,
  calendar: Calendar,
  drive: FileText,
  manual: Sparkles,
};

const DISPOSITION_STYLE: Record<
  BasilEvent["disposition"],
  { label: string; dot: string; text: string; Icon: typeof CheckCircle2 }
> = {
  notify: {
    label: "Heads up",
    dot: "bg-rose-500",
    text: "text-rose-600",
    Icon: AlertTriangle,
  },
  draft: {
    label: "Needs approval",
    dot: "bg-[oklch(0.72_0.15_85)]",
    text: "text-[oklch(0.58_0.15_85)]",
    Icon: Clock,
  },
  auto: {
    label: "Handled",
    dot: "bg-emerald-500",
    text: "text-emerald-600",
    Icon: CheckCircle2,
  },
};

function relTime(d: string): string {
  const diff = Date.now() - new Date(d).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function BasilWatching() {
  const [events, setEvents] = useState<BasilEvent[] | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/events?all=1", { cache: "no-store" });
      const data = await res.json();
      setEvents(data.events || []);
    } catch {
      setEvents([]);
    }
  }, []);

  const pollIntegrations = useCallback(async () => {
    setPolling(true);
    try {
      await fetch("/api/events/poll-ingest", { method: "POST" });
      // New events arrive via SSE; also refresh list in case SSE missed any.
      await load();
    } catch {
      /* ignore — empty state remains */
    } finally {
      setPolling(false);
    }
  }, [load]);

  // Initial load + first-visit poll. We always poll on mount because the
  // alternative (webhook subscriptions) isn't registered yet — polling is
  // how Basil actually sees Gmail / Slack / Calendar right now.
  useEffect(() => {
    (async () => {
      await load();
      await pollIntegrations();
    })();
  }, [load, pollIntegrations]);

  // Live updates over SSE: when a new event is published (via the event bus
  // in /api/events/ingest or any webhook), patch state without a full reload.
  useEffect(() => {
    const es = new EventSource("/api/events/stream");
    es.onmessage = (msg) => {
      try {
        const incoming = JSON.parse(msg.data) as BasilEvent;
        setEvents((prev) => {
          const list = prev ?? [];
          if (list.some((e) => e.id === incoming.id)) {
            return list.map((e) => (e.id === incoming.id ? incoming : e));
          }
          return [incoming, ...list];
        });
      } catch {
        /* ignore malformed */
      }
    };
    es.onerror = () => {
      // EventSource auto-reconnects; nothing to do here.
    };
    return () => es.close();
  }, []);

  const seedIfEmpty = useCallback(async () => {
    await fetch("/api/events/seed", { method: "POST" });
    await load();
  }, [load]);

  const openPanel = useCallback((id?: string) => {
    if (id) setFocusedId(id);
    setPanelOpen(true);
  }, []);

  const closePanel = useCallback(() => {
    setPanelOpen(false);
    setFocusedId(null);
  }, []);

  const { drafts, notifies, auto } = useMemo(() => {
    const list = events ?? [];
    return {
      drafts: list.filter((e) => e.disposition === "draft" && e.status === "pending"),
      notifies: list.filter((e) => e.disposition === "notify" && e.status !== "acknowledged"),
      auto: list.filter((e) => e.disposition === "auto").slice(0, 3),
    };
  }, [events]);

  const total = drafts.length + notifies.length;
  const topThree = [...notifies, ...drafts].slice(0, 3);

  return (
    <>
      <Card className="border-[oklch(0.72_0.15_85)]/30">
        <CardHeader className="flex flex-row items-start justify-between pb-3 gap-3">
          <div className="space-y-1">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Eye className="h-4 w-4 text-[oklch(0.72_0.15_85)]" />
              Basil is watching
            </CardTitle>
            <p className="text-sm text-muted-foreground leading-relaxed max-w-xl">
              Things Basil noticed across your inbox, Slack, calendar and drive.
              Drafts wait for your sign-off. Heads-ups are unread. Handled items
              are filed without asking.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={pollIntegrations}
              disabled={polling}
              title="Pull the latest from Gmail / Slack / Calendar"
              className="inline-flex items-center gap-1 rounded-md border border-border text-[12px] font-medium px-2 py-1 hover:bg-muted/60 transition disabled:opacity-60"
            >
              <RefreshCw className={cn("h-3 w-3", polling && "animate-spin")} />
              {polling ? "Syncing" : "Sync"}
            </button>
            {total > 0 && (
              <button
                onClick={() => openPanel()}
                className="inline-flex items-center gap-1.5 rounded-md bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)] text-[12px] font-semibold px-2.5 py-1.5 hover:brightness-105 transition"
              >
                Review {total} <ArrowRight className="h-3 w-3" />
              </button>
            )}
          </div>
        </CardHeader>

        <CardContent className="space-y-3">
          {events === null ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : events.length === 0 ? (
            <div className="flex flex-col items-center py-6 text-center">
              <Sparkles className="h-6 w-6 text-muted-foreground/40 mb-2" />
              <p className="text-sm text-muted-foreground">
                Quiet for now. Nothing for Basil to watch.
              </p>
              <button
                onClick={seedIfEmpty}
                className="text-[12px] text-muted-foreground/70 hover:text-muted-foreground hover:underline mt-2"
                title="Inserts 8 fabricated events for UI testing only. Do not treat as real."
              >
                Load fake demo events (for UI testing) →
              </button>
            </div>
          ) : (
            <>
              {/* Top 3 active items */}
              <div className="space-y-1.5">
                {topThree.length > 0 ? (
                  topThree.map((e) => {
                    const Icon = SOURCE_ICON[e.source];
                    const ds = DISPOSITION_STYLE[e.disposition];
                    return (
                      <button
                        key={e.id}
                        onClick={() => openPanel(e.id)}
                        className="w-full text-left group relative rounded-lg ring-1 ring-inset ring-border bg-background p-2.5 hover:ring-[oklch(0.72_0.15_85)]/50 transition-all"
                      >
                        <span
                          className={cn(
                            "absolute left-0 top-2.5 h-[calc(100%-1.25rem)] w-[2px] rounded-r-full",
                            ds.dot
                          )}
                        />
                        <div className="flex items-start gap-2.5 pl-2">
                          <Icon className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs font-medium truncate">
                                {e.headline}
                              </span>
                              <span
                                className={cn(
                                  "inline-flex items-center gap-1 text-[12px] font-mono uppercase tracking-wider shrink-0",
                                  ds.text
                                )}
                              >
                                <ds.Icon className="h-2.5 w-2.5" />
                                {ds.label}
                              </span>
                              <span className="text-[12px] font-mono text-muted-foreground ml-auto shrink-0 tabular-nums">
                                {relTime(e.createdAt)}
                              </span>
                            </div>
                            <p className="text-[12px] text-muted-foreground truncate mt-0.5">
                              {e.rationale}
                            </p>
                          </div>
                        </div>
                      </button>
                    );
                  })
                ) : (
                  <p className="text-sm text-muted-foreground italic py-2">
                    Nothing waiting on you — all clear.
                  </p>
                )}
              </div>

              {/* Auto-handled summary strip */}
              {auto.length > 0 && (
                <div className="pt-2 border-t border-border/70">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                    <span className="text-[12px] font-semibold uppercase tracking-[0.18em] text-emerald-600">
                      Handled silently
                    </span>
                    <span className="text-[12px] font-mono text-muted-foreground ml-auto">
                      last {auto.length}
                    </span>
                  </div>
                  <ul className="mt-1.5 space-y-0.5 pl-5">
                    {auto.map((e) => (
                      <li
                        key={e.id}
                        className="text-[12px] text-muted-foreground truncate"
                      >
                        {e.headline}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Footer meta */}
              <div className="pt-1 flex items-center justify-between text-[12px] text-muted-foreground">
                <span>
                  {drafts.length} draft{drafts.length === 1 ? "" : "s"} ·{" "}
                  {notifies.length} heads-up{notifies.length === 1 ? "" : "s"} ·{" "}
                  {auto.length} handled
                </span>
                <Link
                  href="#"
                  onClick={(ev) => {
                    ev.preventDefault();
                    openPanel();
                  }}
                  className="text-[oklch(0.72_0.15_85)] hover:underline"
                >
                  Open queue →
                </Link>
              </div>
            </>
          )}
        </CardContent>
      </Card>

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
