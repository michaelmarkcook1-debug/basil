"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Hash,
  Loader2,
  MessageSquare,
  RefreshCw,
  Settings,
  Thermometer,
  Users,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { relativeTime } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

type SignalType =
  | "reply_needed"
  | "blocker"
  | "promise_made"
  | "decision_pending"
  | "stale_thread"
  | "channel_heat"
  | "person_needs_attention";

type CommandStatus =
  | "missing_env"
  | "not_connected"
  | "auth_expired"
  | "loading"
  | "empty"
  | "ready"
  | "error";

interface Signal {
  id: string;
  type: SignalType;
  urgency: "critical" | "high" | "medium" | "low";
  channelName: string;
  people: string[];
  summary: string;
  whyItMatters: string;
  recommendedAction: string;
  createdAt: string;
}

interface CommandSummary {
  replyNeeded: number;
  blockers: number;
  promises: number;
  decisions: number;
  staleThreads: number;
  hotChannels: number;
}

interface CommandWindow {
  from: string;
  to: string;
  timezone: string;
}

interface CommandResponse {
  status: CommandStatus;
  signals: Signal[];
  summary: CommandSummary;
  window: CommandWindow | null;
  generatedAt: string;
  error?: string;
}

// ─── Signal metadata ──────────────────────────────────────────────────────────

const SIGNAL_META: Record<
  SignalType,
  { label: string; icon: typeof Hash; colour: string; bgColour: string }
> = {
  reply_needed: {
    label: "Reply needed",
    icon: MessageSquare,
    colour: "text-blue-600",
    bgColour: "bg-blue-50 border-blue-200",
  },
  blocker: {
    label: "Blocker",
    icon: AlertTriangle,
    colour: "text-red-600",
    bgColour: "bg-red-50 border-red-200",
  },
  promise_made: {
    label: "Promise made",
    icon: Zap,
    colour: "text-violet-600",
    bgColour: "bg-violet-50 border-violet-200",
  },
  decision_pending: {
    label: "Decision pending",
    icon: Hash,
    colour: "text-amber-600",
    bgColour: "bg-amber-50 border-amber-200",
  },
  stale_thread: {
    label: "Stale thread",
    icon: RefreshCw,
    colour: "text-orange-500",
    bgColour: "bg-orange-50 border-orange-200",
  },
  channel_heat: {
    label: "Channel heat",
    icon: Thermometer,
    colour: "text-pink-600",
    bgColour: "bg-pink-50 border-pink-200",
  },
  person_needs_attention: {
    label: "Person needs attention",
    icon: Users,
    colour: "text-emerald-600",
    bgColour: "bg-emerald-50 border-emerald-200",
  },
};

const URGENCY_BADGE: Record<Signal["urgency"], string> = {
  critical: "bg-red-100 text-red-700 border-red-200",
  high: "bg-amber-100 text-amber-700 border-amber-200",
  medium: "bg-blue-100 text-blue-700 border-blue-200",
  low: "bg-gray-100 text-gray-600 border-gray-200",
};

// ─── Conversion helper ────────────────────────────────────────────────────────

type ConvertTarget = "action" | "decision" | "memory" | "project";

async function convertSignal(signal: Signal, target: ConvertTarget): Promise<void> {
  const res = await fetch("/api/signals/convert", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signalId: signal.id, signalType: signal.type, target, channel: signal.channelName, people: signal.people, text: signal.summary, whyItMatters: signal.whyItMatters, recommendedAction: signal.recommendedAction }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `Failed to convert to ${target}`);
  }
}

// ─── Signal card ─────────────────────────────────────────────────────────────

function SignalCard({ signal }: { signal: Signal }) {
  const meta = SIGNAL_META[signal.type];
  const Icon = meta.icon;
  const [converting, setConverting] = useState<ConvertTarget | null>(null);
  const [done, setDone] = useState<ConvertTarget | null>(null);
  const [convError, setConvError] = useState("");

  async function handleConvert(target: ConvertTarget) {
    setConverting(target);
    setConvError("");
    try {
      await convertSignal(signal, target);
      setDone(target);
    } catch (e) {
      setConvError(e instanceof Error ? e.message : "Conversion failed");
    } finally {
      setConverting(null);
    }
  }

  const convertButtons: { target: ConvertTarget; label: string }[] = [
    { target: "action", label: "→ Action" },
    { target: "decision", label: "→ Decision" },
    { target: "memory", label: "→ Memory" },
    { target: "project", label: "→ Project" },
  ];

  return (
    <Card className={`basil-card border ${meta.bgColour}`}>
      <CardContent className="p-4 space-y-3">
        {/* Header row */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Icon className={`h-4 w-4 shrink-0 ${meta.colour}`} />
            <span className={`text-[11px] font-semibold uppercase tracking-[0.15em] ${meta.colour}`}>
              {meta.label}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span
              className={`text-[10px] font-semibold uppercase tracking-[0.1em] px-2 py-0.5 rounded-full border ${URGENCY_BADGE[signal.urgency]}`}
            >
              {signal.urgency}
            </span>
            <span className="text-[11px] text-muted-foreground">{relativeTime(signal.createdAt)}</span>
          </div>
        </div>

        {/* Channel + people */}
        <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
          <span className="font-medium text-foreground/80">#{signal.channelName}</span>
          {signal.people.length > 0 && (
            <>
              <span>·</span>
              <span>{signal.people.join(", ")}</span>
            </>
          )}
        </div>

        {/* Message text */}
        <p className="text-sm text-foreground/90 leading-relaxed line-clamp-3">{signal.summary}</p>

        {/* Why it matters */}
        {signal.whyItMatters && (
          <div className="rounded-lg bg-white/70 border border-black/5 px-3 py-2">
            <p className="text-[11px] text-muted-foreground uppercase tracking-[0.12em] mb-0.5">
              Why it matters
            </p>
            <p className="text-xs text-foreground/80">{signal.whyItMatters}</p>
          </div>
        )}

        {/* Recommended action */}
        {signal.recommendedAction && (
          <p className="text-xs text-muted-foreground italic">{signal.recommendedAction}</p>
        )}

        {/* Convert buttons */}
        <div className="flex flex-wrap gap-1.5 pt-1">
          {convertButtons.map(({ target, label }) => (
            <button
              key={target}
              onClick={() => void handleConvert(target)}
              disabled={converting !== null || done !== null}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium border transition-all
                ${done === target
                  ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                  : "bg-white/80 border-black/10 text-muted-foreground hover:text-foreground hover:border-black/20 disabled:opacity-50 disabled:cursor-not-allowed"
                }`}
            >
              {converting === target ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : done === target ? (
                <Check className="h-3 w-3" />
              ) : null}
              {done === target ? "Saved" : label}
            </button>
          ))}
        </div>

        {convError && (
          <p className="text-[11px] text-red-600">{convError}</p>
        )}
      </CardContent>
    </Card>
  );
}

// ─── State panels ─────────────────────────────────────────────────────────────

function MissingEnvPanel() {
  return (
    <div className="rounded-2xl basil-card p-12 text-center space-y-4">
      <Hash className="h-12 w-12 mx-auto text-muted-foreground/30" />
      <h2 className="basil-display text-2xl">Slack not configured</h2>
      <p className="text-sm text-muted-foreground max-w-md mx-auto">
        A Slack bot token is required. Add <code className="bg-muted px-1 rounded text-xs">SLACK_BOT_TOKEN</code> to your environment variables in Settings.
      </p>
      <a
        href="/dashboard/settings"
        className="inline-flex items-center gap-2 rounded-lg bg-[oklch(0.72_0.15_85)] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
      >
        <Settings className="h-4 w-4" />
        Open Settings
      </a>
    </div>
  );
}

function NotConnectedPanel() {
  return (
    <div className="rounded-2xl basil-card p-12 text-center space-y-4">
      <Hash className="h-12 w-12 mx-auto text-muted-foreground/30" />
      <h2 className="basil-display text-2xl">Slack not connected</h2>
      <p className="text-sm text-muted-foreground max-w-md mx-auto">
        Connect a Slack workspace to surface replies, blockers, promises, and channel heat.
      </p>
      <a
        href="/dashboard/settings"
        className="inline-flex items-center gap-2 rounded-lg bg-[oklch(0.72_0.15_85)] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
      >
        Connect Slack <ArrowRight className="h-4 w-4" />
      </a>
    </div>
  );
}

function AuthExpiredPanel() {
  return (
    <div className="rounded-2xl basil-card p-12 text-center space-y-4">
      <AlertTriangle className="h-12 w-12 mx-auto text-amber-400" />
      <h2 className="basil-display text-2xl">Slack token expired</h2>
      <p className="text-sm text-muted-foreground max-w-md mx-auto">
        Your Slack connection needs to be re-authorised. Go to Settings to reconnect.
      </p>
      <a
        href="/dashboard/settings"
        className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-white hover:opacity-90"
      >
        Reconnect Slack <ArrowRight className="h-4 w-4" />
      </a>
    </div>
  );
}

function EmptyPanel() {
  return (
    <div className="rounded-2xl basil-card p-12 text-center space-y-3">
      <Check className="h-12 w-12 mx-auto text-emerald-400" />
      <h2 className="basil-display text-2xl">All clear</h2>
      <p className="text-sm text-muted-foreground max-w-md mx-auto">
        No signals requiring your attention right now. Basil will surface anything that needs you next time you refresh.
      </p>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

const ALL_SIGNAL_TYPES = Object.keys(SIGNAL_META) as SignalType[];

export default function SlackCommandPage() {
  const [response, setResponse] = useState<CommandResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeFilter, setActiveFilter] = useState<SignalType | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 28_000);
    try {
      const res = await fetch("/api/stig/slack-command", {
        cache: "no-store",
        signal: controller.signal,
      });
      const body = await res.json() as CommandResponse;
      setResponse(body);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        setError("Slack is taking too long to respond. Check your connection in Settings.");
      } else {
        setError(e instanceof Error ? e.message : "Failed to load Slack Command Centre");
      }
    } finally {
      clearTimeout(timeoutId);
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Derive filtered signals
  const allSignals = response?.signals ?? [];
  const filteredSignals = activeFilter
    ? allSignals.filter((s) => s.type === activeFilter)
    : allSignals;

  // Count per type for filter chips
  const typeCounts = ALL_SIGNAL_TYPES.reduce<Record<SignalType, number>>((acc, t) => {
    acc[t] = allSignals.filter((s) => s.type === t).length;
    return acc;
  }, {} as Record<SignalType, number>);

  const status = response?.status ?? (loading ? "loading" : "error");

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="space-y-2">
          <p className="basil-eyebrow flex items-center gap-2">
            <Hash className="h-3.5 w-3.5" />
            Slack Command Centre
          </p>
          <h1 className="basil-display text-3xl sm:text-5xl leading-[1.05] text-foreground">
            Signal before noise<span className="text-[oklch(0.72_0.15_85)]">.</span>
          </h1>
          <p className="text-sm text-muted-foreground max-w-2xl leading-relaxed">
            Basil reads Slack as your operating layer — replies, blockers, promises, stale threads, and channel heat. Not to read everything. To know what needs you.
          </p>
        </div>
        <Button onClick={() => void load()} disabled={loading} variant="outline" className="gap-2 shrink-0">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </Button>
      </header>

      {/* Generic error (not a state-panel error) */}
      {error && status === "error" && (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-5 py-4 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* State panels */}
      {status === "loading" && (
        <div className="rounded-2xl basil-card p-10 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Reading Slack signal…
        </div>
      )}

      {status === "missing_env" && <MissingEnvPanel />}
      {status === "not_connected" && <NotConnectedPanel />}
      {status === "auth_expired" && <AuthExpiredPanel />}
      {status === "empty" && <EmptyPanel />}

      {/* Ready state */}
      {status === "ready" && response && (
        <>
          {/* Summary stats */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {(["reply_needed", "blocker", "promise_made", "decision_pending"] as SignalType[]).map((t) => {
              const meta = SIGNAL_META[t];
              const Icon = meta.icon;
              const count = typeCounts[t];
              // Also check summary fields for types not in signals array
              const summaryCount =
                t === "reply_needed" ? response.summary.replyNeeded :
                t === "blocker" ? response.summary.blockers :
                t === "promise_made" ? response.summary.promises :
                t === "decision_pending" ? response.summary.decisions :
                count;
              const displayCount = Math.max(count, summaryCount);
              const isActive = activeFilter === t;
              return (
                <button
                  key={t}
                  onClick={() => setActiveFilter(isActive ? null : t)}
                  className={`text-left rounded-xl border p-4 transition-all ${
                    isActive
                      ? `${meta.bgColour} shadow-sm`
                      : "basil-card hover:shadow-sm"
                  }`}
                >
                  <div className="flex items-center gap-1.5 mb-1">
                    <Icon className={`h-3.5 w-3.5 ${meta.colour}`} />
                    <p className="text-[11px] uppercase tracking-[0.15em] text-muted-foreground">
                      {meta.label}
                    </p>
                  </div>
                  <p className={`text-2xl font-semibold ${meta.colour}`}>{displayCount}</p>
                </button>
              );
            })}
          </div>

          {/* Filter chips for remaining signal types */}
          {(["stale_thread", "channel_heat", "person_needs_attention"] as SignalType[]).some(
            (t) => typeCounts[t] > 0
          ) && (
            <div className="flex flex-wrap gap-2">
              {(["stale_thread", "channel_heat", "person_needs_attention"] as SignalType[]).map((t) => {
                const meta = SIGNAL_META[t];
                const Icon = meta.icon;
                const count = typeCounts[t];
                if (count === 0) return null;
                const isActive = activeFilter === t;
                return (
                  <button
                    key={t}
                    onClick={() => setActiveFilter(isActive ? null : t)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                      isActive
                        ? `${meta.bgColour} ${meta.colour}`
                        : "bg-white border-black/10 text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Icon className="h-3 w-3" />
                    {meta.label}
                    <span className="ml-0.5 opacity-70">{count}</span>
                  </button>
                );
              })}
              {activeFilter && (
                <button
                  onClick={() => setActiveFilter(null)}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs text-muted-foreground hover:text-foreground border border-black/10"
                >
                  Clear filter
                </button>
              )}
            </div>
          )}

          {/* Signal cards */}
          {filteredSignals.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">
              No {activeFilter ? SIGNAL_META[activeFilter].label.toLowerCase() : ""} signals right now.
            </p>
          ) : (
            <div className="space-y-3">
              {filteredSignals.map((signal) => (
                <SignalCard key={signal.id} signal={signal} />
              ))}
            </div>
          )}

          {/* Channel heat summary */}
          {response.summary.hotChannels > 0 && (
            <div className="basil-card rounded-xl p-4 flex items-center gap-3">
              <Thermometer className="h-4 w-4 text-pink-500 shrink-0" />
              <span className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{response.summary.hotChannels}</span> active channel{response.summary.hotChannels !== 1 ? "s" : ""} with signal activity
              </span>
            </div>
          )}

          {/* Footer */}
          <footer className="text-[11px] text-muted-foreground flex items-center justify-between">
            {response.window ? (
              <span>Window: {relativeTime(response.window.from)} → now</span>
            ) : (
              <span />
            )}
            <span>Generated {relativeTime(response.generatedAt)}</span>
          </footer>
        </>
      )}
    </div>
  );
}
