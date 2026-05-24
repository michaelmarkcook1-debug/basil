"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  RefreshCw,
  Activity,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Zap,
  Brain,
  TrendingUp,
  Shield,
  Clock,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ParityGate {
  gate: string;
  required: number | string;
  observed: number | string;
  passed: boolean;
  explanation: string;
}

interface ParityReport {
  generatedAt: string;
  cutoversAllowed: boolean;
  shadowDays: number;
  gates: ParityGate[];
  metrics: {
    total: number;
    exactMatchRate: number;
    criticalDiffRate: number;
  };
  blockedReason: string | null;
}

interface DispatchByIntent {
  count: number;
  avgLatencyMs: number;
  errors: number;
}

interface DispatchMetrics {
  total: number;
  successRate: number;
  avgLatencyMs: number;
  errorCount: number;
  byIntent: Record<string, DispatchByIntent>;
}

interface FeatureFlags {
  signalEvent_shadow: boolean;
  signalEvent_active: boolean;
  trustEnvelope_active: boolean;
  canonicalIdentity_active: boolean;
  signalThread_active: boolean;
  dispatch_shadow: boolean;
  dispatch_active: boolean;
  ranking_active: boolean;
}

interface ContextSummary {
  assembledInMs: number;
  context: {
    estimatedTokens: number;
    tokenBudget: number;
    recentSignals: unknown[];
    topRankedPending: unknown[];
    unresolvedActionCount: number;
    assembledAt: string;
  };
  flagsActive: Record<string, boolean>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number, decimals = 0): string {
  return n.toFixed(decimals);
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function formatShadowAge(days: number): string {
  if (days < 1 / 1440) {
    // Less than 1 minute
    const secs = Math.round(days * 86400);
    return `${secs}s`;
  }
  if (days < 1 / 24) {
    // Less than 1 hour
    const mins = Math.round(days * 1440);
    return `${mins}m`;
  }
  if (days < 1) {
    // Less than 1 day
    const hours = (days * 24).toFixed(1);
    return `${hours}h`;
  }
  return `${days.toFixed(1)}d`;
}

// Rate gates store values as 0-100 floats (e.g. 100.0, 0.0) — append %.
// Count/age gates (minSampleSize, minShadowDays) are plain numbers.
function isRateGate(gateName: string): boolean {
  const n = gateName.toLowerCase();
  return n.includes("rate") || n.includes("matchrate");
}

function fmtGateVal(gate: ParityGate, field: "required" | "observed"): string {
  const val = gate[field];
  if (typeof val === "string") return val; // already formatted (e.g. "< 2")
  if (isRateGate(gate.gate)) return `${val}%`;
  return String(val);
}

function GateRow({ gate }: { gate: ParityGate }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-border/50 last:border-0">
      <span className="text-sm text-muted-foreground capitalize">
        {gate.gate.replace(/([A-Z])/g, " $1").trim()}
      </span>
      <div className="flex items-center gap-3">
        <span className="text-xs font-mono text-muted-foreground">
          need {fmtGateVal(gate, "required")}
        </span>
        <span className={cn(
          "text-sm font-mono font-medium tabular-nums",
          gate.passed ? "text-emerald-600" : "text-red-500"
        )}>
          {fmtGateVal(gate, "observed")}
        </span>
        {gate.passed
          ? <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />
          : <XCircle className="h-3.5 w-3.5 text-red-500" />}
      </div>
    </div>
  );
}

function FlagToggle({
  label,
  flagKey,
  value,
  onToggle,
  toggling,
}: {
  label: string;
  flagKey: string;
  value: boolean;
  onToggle: (key: string, value: boolean) => void;
  toggling: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
      <span className="text-sm font-mono">{label}</span>
      <button
        onClick={() => onToggle(flagKey, !value)}
        disabled={toggling}
        className={cn(
          "flex items-center gap-1.5 text-xs font-medium transition-colors",
          value ? "text-emerald-600" : "text-muted-foreground"
        )}
        title={value ? "Click to disable" : "Click to enable"}
      >
        {value
          ? <ToggleRight className="h-5 w-5" />
          : <ToggleLeft className="h-5 w-5" />}
        {value ? "on" : "off"}
      </button>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function TelemetryPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [parity, setParity] = useState<ParityReport | null>(null);
  const [dispatch, setDispatch] = useState<DispatchMetrics | null>(null);
  const [flags, setFlags] = useState<FeatureFlags | null>(null);
  const [context, setContext] = useState<ContextSummary | null>(null);
  const [toggling, setToggling] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [parityRes, dispatchRes, flagsRes, ctxRes] = await Promise.allSettled([
      fetch("/api/admin/parity-status").then((r) => r.json()),
      fetch("/api/admin/dispatch-log?metrics=1&limit=0").then((r) => r.json()),
      fetch("/api/admin/feature-flags").then((r) => r.json()),
      fetch("/api/admin/intelligence-context?serialized=0").then((r) => r.json()),
    ]);
    if (parityRes.status === "fulfilled") setParity(parityRes.value.report ?? null);
    if (dispatchRes.status === "fulfilled") setDispatch(dispatchRes.value.metrics ?? null);
    if (flagsRes.status === "fulfilled") setFlags(flagsRes.value.flags ?? null);
    if (ctxRes.status === "fulfilled") setContext(ctxRes.value);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function toggleFlag(key: string, value: boolean) {
    setToggling(true);
    try {
      await fetch("/api/admin/feature-flags", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
      await load();
    } finally {
      setToggling(false);
    }
  }

  const FLAG_LABELS: [keyof FeatureFlags, string][] = [
    ["signalEvent_shadow",      "signalEvent_shadow"],
    ["signalEvent_active",      "signalEvent_active"],
    ["canonicalIdentity_active","canonicalIdentity_active"],
    ["ranking_active",          "ranking_active"],
    ["signalThread_active",     "signalThread_active"],
    ["dispatch_shadow",         "dispatch_shadow"],
    ["dispatch_active",         "dispatch_active"],
  ];

  return (
    <div className="min-h-screen basil-surface">
      <div className="max-w-4xl mx-auto px-4 py-8 sm:px-6 space-y-6">

        {/* Header */}
        <div>
          <Button
            variant="ghost" size="sm"
            onClick={() => router.push("/admin")}
            className="gap-1.5 text-muted-foreground -ml-2 mb-6"
          >
            <ArrowLeft className="h-4 w-4" /> Admin
          </Button>
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <Activity className="h-5 w-5 text-[oklch(0.72_0.15_85)]" />
                <h1 className="basil-display text-2xl sm:text-3xl">Telemetry</h1>
              </div>
              <p className="text-sm text-muted-foreground">
                Parity gates · Dispatch observability · Feature flags · Intelligence context
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={load} disabled={loading} className="gap-1.5 shrink-0">
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
              Refresh
            </Button>
          </div>
        </div>

        {/* ── Parity status ─────────────────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center justify-between text-sm font-medium">
              <span className="flex items-center gap-2">
                <Shield className="h-4 w-4 text-[oklch(0.72_0.15_85)]" />
                Parity Gates
              </span>
              {parity && (
                <span className={cn(
                  "text-xs font-mono px-2 py-0.5 rounded-full",
                  parity.cutoversAllowed
                    ? "bg-emerald-500/10 text-emerald-600"
                    : "bg-red-500/10 text-red-600"
                )}>
                  {parity.cutoversAllowed ? "✓ cutover allowed" : "✗ cutover blocked"}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading || !parity ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-3 mb-4">
                  <div className="rounded-lg bg-muted/50 p-3 text-center">
                    <p className="text-2xl font-mono font-semibold tabular-nums">
                      {formatShadowAge(parity.shadowDays)}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">shadow age</p>
                  </div>
                  <div className="rounded-lg bg-muted/50 p-3 text-center">
                    <p className="text-2xl font-mono font-semibold tabular-nums">
                      {parity.metrics.total}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">comparisons</p>
                  </div>
                  <div className="rounded-lg bg-muted/50 p-3 text-center">
                    <p className={cn(
                      "text-2xl font-mono font-semibold tabular-nums",
                      parity.metrics.exactMatchRate >= 0.9 ? "text-emerald-600" : "text-amber-600"
                    )}>
                      {pct(parity.metrics.exactMatchRate)}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">exact match</p>
                  </div>
                </div>
                <div className="rounded-lg border border-border p-3 space-y-0">
                  {parity.gates.map((g) => <GateRow key={g.gate} gate={g} />)}
                </div>
                {parity.blockedReason && (
                  <p className="mt-3 flex items-start gap-1.5 text-xs text-amber-600">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    {parity.blockedReason}
                  </p>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* ── Dispatch metrics ──────────────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Zap className="h-4 w-4 text-[oklch(0.72_0.15_85)]" />
              Dispatch Observability
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading || !dispatch ? (
              <p className="text-sm text-muted-foreground">{loading ? "Loading…" : "No dispatch data yet. Enable dispatch_shadow to start."}</p>
            ) : (
              <>
                <div className="grid grid-cols-4 gap-3 mb-4">
                  {[
                    { label: "total calls", value: dispatch.total },
                    { label: "success rate", value: pct(dispatch.successRate), color: dispatch.successRate >= 0.95 ? "text-emerald-600" : "text-amber-600" },
                    { label: "avg latency", value: `${dispatch.avgLatencyMs}ms` },
                    { label: "errors", value: dispatch.errorCount, color: dispatch.errorCount > 0 ? "text-red-500" : undefined },
                  ].map(({ label, value, color }) => (
                    <div key={label} className="rounded-lg bg-muted/50 p-3 text-center">
                      <p className={cn("text-2xl font-mono font-semibold tabular-nums", color)}>{value}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
                    </div>
                  ))}
                </div>
                {Object.keys(dispatch.byIntent).length > 0 && (
                  <div className="rounded-lg border border-border p-3 space-y-0">
                    {Object.entries(dispatch.byIntent)
                      .sort(([, a], [, b]) => b.count - a.count)
                      .map(([intent, data]) => (
                        <div key={intent} className="flex items-center justify-between py-1.5 border-b border-border/50 last:border-0">
                          <span className="text-xs font-mono text-muted-foreground">{intent}</span>
                          <div className="flex items-center gap-4 text-xs font-mono tabular-nums">
                            <span>{data.count}×</span>
                            <span className="text-muted-foreground">{Math.round(data.avgLatencyMs)}ms</span>
                            {data.errors > 0 && (
                              <span className="text-red-500">{data.errors} err</span>
                            )}
                          </div>
                        </div>
                      ))}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* ── Two column: flags + context ───────────────────────────────── */}
        <div className="grid gap-6 sm:grid-cols-2">

          {/* Feature flags */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                <TrendingUp className="h-4 w-4 text-[oklch(0.72_0.15_85)]" />
                Feature Flags
              </CardTitle>
            </CardHeader>
            <CardContent>
              {loading || !flags ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : (
                <div className="space-y-0">
                  {FLAG_LABELS.map(([key, label]) => (
                    <FlagToggle
                      key={key}
                      label={label}
                      flagKey={key}
                      value={flags[key]}
                      onToggle={toggleFlag}
                      toggling={toggling}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Intelligence context snapshot */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                <Brain className="h-4 w-4 text-[oklch(0.72_0.15_85)]" />
                Intelligence Context
              </CardTitle>
            </CardHeader>
            <CardContent>
              {loading || !context ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { label: "tokens used", value: `${context.context.estimatedTokens} / ${context.context.tokenBudget}` },
                      { label: "assembled in", value: `${context.assembledInMs}ms` },
                      { label: "recent signals", value: context.context.recentSignals.length },
                      { label: "top ranked", value: context.context.topRankedPending.length },
                    ].map(({ label, value }) => (
                      <div key={label} className="rounded-md bg-muted/50 p-2.5 text-center">
                        <p className="text-lg font-mono font-semibold tabular-nums">{value}</p>
                        <p className="text-[11px] text-muted-foreground mt-0.5">{label}</p>
                      </div>
                    ))}
                  </div>
                  <div className="rounded-md border border-border p-2.5 space-y-1.5">
                    <p className="text-[10px] text-muted-foreground/60 mb-1.5">flags at context-build time (60s cache)</p>
                    {Object.entries(context.flagsActive).map(([key, val]) => (
                      <div key={key} className="flex items-center justify-between text-xs">
                        <span className="font-mono text-muted-foreground">{key}</span>
                        <span className={val ? "text-emerald-600" : "text-muted-foreground/50"}>
                          {val ? "on" : "off"}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    assembled {context.context.assembledAt
                      ? new Date(context.context.assembledAt).toLocaleTimeString()
                      : "—"}
                  </div>
                  {context.context.unresolvedActionCount > 0 && (
                    <p className="text-xs text-amber-600">
                      {context.context.unresolvedActionCount} unresolved action{context.context.unresolvedActionCount !== 1 ? "s" : ""} in workload
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

      </div>
    </div>
  );
}
