"use client";

/**
 * HealthPanel — compact system health strip for the settings page.
 *
 * Polls GET /api/system/health on mount and every 60 s.
 * Color legend: green = working, amber = stale/warning, red = error, grey = not connected.
 * Every non-green tile shows a plain-English next action.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Circle,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Activity,
  Hash,
  Mail,
  CalendarCheck,
  Brain,
} from "lucide-react";
import type { HealthColor, HealthTile, SystemHealthReport } from "@/lib/system/health";

// ── Color primitives ──────────────────────────────────────────────────────────

const DOT_CLASS: Record<HealthColor, string> = {
  green: "bg-signal-positive",
  amber: "bg-signal-warning",
  red:   "bg-signal-critical",
  grey:  "bg-zinc-300",
};

const BADGE_CLASS: Record<HealthColor, string> = {
  green: "bg-signal-positive-subtle text-signal-positive border border-signal-positive-border",
  amber: "bg-signal-warning-subtle  text-signal-warning  border border-signal-warning-border",
  red:   "bg-signal-critical-subtle    text-signal-critical    border border-signal-critical-border",
  grey:  "bg-zinc-50   text-zinc-500   border border-zinc-200",
};

const ICON: Record<HealthColor, React.ReactNode> = {
  green: <CheckCircle2 className="h-3.5 w-3.5 text-signal-positive shrink-0" />,
  amber: <AlertTriangle className="h-3.5 w-3.5 text-signal-warning shrink-0" />,
  red:   <XCircle className="h-3.5 w-3.5 text-signal-critical shrink-0" />,
  grey:  <Circle className="h-3.5 w-3.5 text-zinc-300 shrink-0" />,
};

// ── Relative-time helper (client-side re-check of lastCheckedAt) ──────────────

function relAgo(iso?: string): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 5)  return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

// ── Overall summary banner ────────────────────────────────────────────────────

function SummaryBanner({
  report,
  loading,
  onRefresh,
}: {
  report: SystemHealthReport | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  if (!report) {
    return (
      <div className="flex items-center justify-between gap-3 pb-3 border-b border-border">
        <div className="flex items-center gap-2">
          <div className="h-3 w-3 rounded-full bg-zinc-200 animate-pulse" />
          <span className="text-sm text-muted-foreground">Checking…</span>
        </div>
        <Button variant="ghost" size="sm" disabled className="gap-1.5 text-muted-foreground h-7 px-2">
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  const { overallColor, issueCount, warnCount, checkedAt } = report;

  let summaryText: string;
  if (issueCount > 0)       summaryText = `${issueCount} issue${issueCount > 1 ? "s" : ""} need${issueCount === 1 ? "s" : ""} attention`;
  else if (warnCount > 0)   summaryText = `${warnCount} warning${warnCount > 1 ? "s" : ""}`;
  else                      summaryText = "All systems healthy";

  const bannerClass: Record<HealthColor, string> = {
    green: "bg-signal-positive-subtle border-signal-positive-border text-signal-positive",
    amber: "bg-signal-warning-subtle  border-signal-warning-border  text-signal-warning",
    red:   "bg-signal-critical-subtle    border-signal-critical-border    text-signal-critical",
    grey:  "bg-zinc-50   border-zinc-200   text-zinc-600",
  };

  return (
    <div className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 mb-4 ${bannerClass[overallColor]}`}>
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${DOT_CLASS[overallColor]}`} />
        <span className="text-[13px] font-medium">{summaryText}</span>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs opacity-70 tabular-nums">
          {relAgo(checkedAt)}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={loading}
          className="gap-1 h-6 px-2 text-xs opacity-70 hover:opacity-100"
          title="Refresh health check"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>
    </div>
  );
}

// ── Individual tile row ───────────────────────────────────────────────────────

function TileRow({ tile }: { tile: HealthTile }) {
  const [expanded, setExpanded] = useState(false);
  const hasAction = !!tile.nextAction;
  const hasSub    = (tile.sub?.length ?? 0) > 0;
  const expandable = hasAction || hasSub;

  return (
    <div className="py-2 first:pt-0 last:pb-0">
      <div
        className={`flex items-center gap-2.5 min-h-[28px] ${expandable ? "cursor-pointer group" : ""}`}
        onClick={expandable ? () => setExpanded((p) => !p) : undefined}
        role={expandable ? "button" : undefined}
        aria-expanded={expandable ? expanded : undefined}
      >
        {/* Color icon */}
        {ICON[tile.color]}

        {/* Label */}
        <span className="text-[13px] font-medium text-foreground w-36 shrink-0 leading-tight">
          {tile.label}
        </span>

        {/* Status badge */}
        <span
          className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium leading-tight tabular-nums ${BADGE_CLASS[tile.color]}`}
        >
          {tile.statusText}
        </span>

        {/* Spacer */}
        <span className="flex-1" />

        {/* Last checked */}
        <span className="text-xs text-muted-foreground tabular-nums shrink-0 hidden sm:block">
          {relAgo(tile.lastCheckedAt)}
        </span>

        {/* Expand toggle */}
        {expandable && (
          <span className="text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity ml-1">
            {expanded
              ? <ChevronDown className="h-3.5 w-3.5" />
              : <ChevronRight className="h-3.5 w-3.5" />}
          </span>
        )}
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="mt-1.5 ml-[22px] space-y-1.5">
          {/* Sub-service pills */}
          {hasSub && (
            <div className="flex flex-wrap gap-1.5">
              {tile.sub!.map((s) => (
                <span
                  key={s.label}
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                    s.ok
                      ? "bg-signal-positive-subtle text-signal-positive border border-signal-positive-border"
                      : "bg-zinc-100 text-zinc-500 border border-zinc-200"
                  }`}
                >
                  {s.ok
                    ? <CheckCircle2 className="h-2.5 w-2.5" />
                    : <Circle className="h-2.5 w-2.5" />}
                  {s.label}
                </span>
              ))}
            </div>
          )}
          {/* Next action */}
          {hasAction && (
            <p className="text-[12px] text-muted-foreground leading-relaxed">
              <span className="font-medium text-foreground/70">Next: </span>
              {tile.nextAction}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Section ───────────────────────────────────────────────────────────────────

function Section({
  title,
  tiles,
  defaultOpen = true,
}: {
  title: string;
  tiles: HealthTile[];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // Auto-open if any tile is non-green
  const hasIssue = tiles.some((t) => t.color !== "green" && t.color !== "grey");

  // Open automatically when issues appear after first render
  const prevHasIssue = useRef(hasIssue);
  useEffect(() => {
    if (hasIssue && !prevHasIssue.current) setOpen(true);
    prevHasIssue.current = hasIssue;
  }, [hasIssue]);

  return (
    <div>
      <button
        className="flex items-center gap-1.5 w-full text-left py-1 group"
        onClick={() => setOpen((p) => !p)}
        aria-expanded={open}
      >
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground group-hover:text-foreground transition-colors">
          {title}
        </span>
        {open
          ? <ChevronDown className="h-3 w-3 text-muted-foreground" />
          : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
        {/* Issue count pill */}
        {tiles.filter((t) => t.color === "red").length > 0 && (
          <span className="ml-1 inline-flex items-center rounded-full bg-signal-critical-subtle text-signal-critical text-xs font-semibold px-1.5 py-0.5">
            {tiles.filter((t) => t.color === "red").length}
          </span>
        )}
        {tiles.filter((t) => t.color === "red").length === 0 &&
          tiles.filter((t) => t.color === "amber").length > 0 && (
          <span className="ml-1 inline-flex items-center rounded-full bg-signal-warning-subtle text-signal-warning text-xs font-semibold px-1.5 py-0.5">
            {tiles.filter((t) => t.color === "amber").length}
          </span>
        )}
      </button>

      {open && (
        <div className="mt-0.5 divide-y divide-border/50 pl-0.5">
          {tiles.map((tile) => (
            <TileRow key={tile.id} tile={tile} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Manual sync strip ─────────────────────────────────────────────────────────

type SyncJob = "slack" | "ingest" | "calendar" | "briefing";
type SyncState = "idle" | "running" | "done" | "error";

function SyncButton({
  icon: Icon,
  label,
  job,
  onComplete,
}: {
  icon: typeof Hash;
  label: string;
  job: SyncJob;
  onComplete: () => void;
}) {
  const [state, setState] = useState<SyncState>("idle");
  const [msg, setMsg] = useState("");

  async function trigger() {
    setState("running");
    setMsg("");
    try {
      const res = await fetch("/api/settings/sync-now", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobs: [job] }),
      });
      const body = await res.json() as { ok?: boolean; results?: Record<string, { ok?: boolean; messageCount?: number; status?: string; reason?: string; error?: string }> };
      if (!res.ok || !body.ok) throw new Error("Sync failed");
      const r = body.results?.[job];
      if (r?.ok === false) {
        if (r.reason === "not_connected") {
          setMsg("Not connected");
        } else {
          setMsg(r.error ?? "Failed");
        }
        setState("error");
      } else {
        if (job === "slack" && typeof r?.messageCount === "number") {
          setMsg(`${r.messageCount} messages`);
        } else if (job === "ingest") {
          setMsg("Running in background");
        } else if (job === "calendar") {
          setMsg("Webhook registered");
        } else if (job === "briefing") {
          setMsg("Generating in background");
        }
        setState("done");
        setTimeout(() => { setState("idle"); setMsg(""); }, 8_000);
        onComplete();
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Error");
      setState("error");
      setTimeout(() => { setState("idle"); setMsg(""); }, 5_000);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={() => void trigger()}
        disabled={state === "running"}
        className={`gap-1.5 h-7 text-[12px] ${
          state === "done" ? "border-signal-positive-border text-signal-positive" :
          state === "error" ? "border-signal-critical-border text-signal-critical" : ""
        }`}
      >
        {state === "running" ? (
          <RefreshCw className="h-3 w-3 animate-spin" />
        ) : state === "done" ? (
          <CheckCircle2 className="h-3 w-3 text-signal-positive" />
        ) : state === "error" ? (
          <XCircle className="h-3 w-3 text-signal-critical" />
        ) : (
          <Icon className="h-3 w-3" />
        )}
        {state === "running" ? "Syncing…" : label}
      </Button>
      {msg && (
        <span className={`text-xs ${state === "error" ? "text-signal-critical" : "text-muted-foreground"}`}>
          {msg}
        </span>
      )}
    </div>
  );
}

function SyncNowStrip({ onSynced }: { onSynced: () => void }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-muted/30 px-3 py-3 space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Sync now
      </p>
      <div className="flex flex-wrap gap-2">
        <SyncButton icon={Hash}          label="Sync Slack"      job="slack"     onComplete={onSynced} />
        <SyncButton icon={Mail}          label="Run ingest"      job="ingest"    onComplete={onSynced} />
        <SyncButton icon={CalendarCheck} label="Register calendar webhook" job="calendar" onComplete={onSynced} />
        <SyncButton icon={Brain}         label="Generate briefing" job="briefing" onComplete={onSynced} />
      </div>
      <p className="text-xs text-muted-foreground">
        Slack syncs hourly · Ingest runs every 6 hours · Calendar webhook auto-renews monthly · or trigger manually here
      </p>
    </div>
  );
}

// ── Main panel component ──────────────────────────────────────────────────────

export function HealthPanel() {
  const [report, setReport] = useState<SystemHealthReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchHealth = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/system/health", { cache: "no-store" });
      if (!res.ok) {
        let errMsg = `HTTP ${res.status}`;
        try {
          const j = await res.json() as { error?: string };
          if (j.error) errMsg = j.error;
        } catch {
          // JSON parse failed — use the status code message
        }
        console.error("[basil-fetch]", res.status === 401 ? "auth_error" : "server_error", { route: "/api/system/health", status: res.status, component: "HealthPanel" });
        throw new Error(errMsg);
      }
      const data = (await res.json()) as SystemHealthReport;
      setReport(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Health check failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchHealth();
    // Refresh every 60 s so the panel stays current without a page reload.
    intervalRef.current = setInterval(() => void fetchHealth(), 60_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchHealth]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          System health
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary banner */}
        <SummaryBanner report={report} loading={loading} onRefresh={fetchHealth} />

        {/* Error state */}
        {error && (
          <div className="rounded-lg bg-signal-critical-subtle border border-signal-critical-border px-3 py-2 text-[13px] text-signal-critical flex items-center gap-2">
            <XCircle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        {/* Loading skeleton */}
        {loading && !report && (
          <div className="space-y-3 animate-pulse">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="space-y-2">
                <div className="h-3 w-24 bg-zinc-100 rounded" />
                {[...Array(3)].map((_, j) => (
                  <div key={j} className="flex items-center gap-2.5">
                    <div className="h-3.5 w-3.5 rounded-full bg-zinc-100" />
                    <div className="h-3 w-28 bg-zinc-100 rounded" />
                    <div className="h-5 w-24 bg-zinc-100 rounded-md" />
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        {/* Manual sync strip — always visible so user can trigger without waiting for cron */}
        <SyncNowStrip onSynced={fetchHealth} />

        {/* Sections */}
        {report && (
          <div className="space-y-4">
            {report.sections.map((section) => (
              <Section
                key={section.id}
                title={section.title}
                tiles={section.tiles}
                defaultOpen={true}
              />
            ))}
          </div>
        )}

        {/* Legend */}
        {report && (
          <div className="pt-2 border-t border-border flex flex-wrap gap-x-4 gap-y-1">
            {(["green", "amber", "red", "grey"] as HealthColor[]).map((c) => {
              const labels: Record<HealthColor, string> = {
                green: "Working",
                amber: "Stale / warning",
                red:   "Error — action needed",
                grey:  "Not connected",
              };
              return (
                <span key={c} className="flex items-center gap-1 text-xs text-muted-foreground">
                  <span className={`h-2 w-2 rounded-full ${DOT_CLASS[c]}`} />
                  {labels[c]}
                </span>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
