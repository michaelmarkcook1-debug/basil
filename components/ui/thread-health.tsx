"use client";

/**
 * Thread health visual system.
 *
 * Exports:
 *   ThreadHealthBadge     — compact state chip (thread list, contact cards)
 *   ThreadHealthPanel     — full multi-signal breakdown (thread detail)
 *   RelationshipAlerts    — operational alert list
 *   SilenceIndicator      — days-since-contact surface
 *   RelationshipTrendDot  — coloured trend dot for inline use
 *   RelationshipHealthRow — single contact health row (relationship grid)
 *   RelationshipHealthGrid — contact health overview (homepage widget)
 *
 * Design principles:
 *   - Operational language only. No scores, no social metaphors.
 *   - Every state is explained by its signals.
 *   - Colour is used sparingly — only for actionable warnings.
 *   - Progressive disclosure: badge → panel → full alerts.
 */

import { useMemo } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  ArrowDownRight,
  Minus,
  AlertTriangle,
  AlertCircle,
  Info,
  Clock,
  Zap,
  CheckSquare,
  Activity,
  TrendingDown,
  ExternalLink,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  HealthState,
  HealthTrend,
  SignalStatus,
  HealthDimension,
  HealthSignal,
  HealthAlert,
  ThreadHealth,
  AlertSeverity,
  ContactHealth,
} from "@/lib/relationship/types";

// ── Design tokens (module-level) ──────────────────────────────────────────────

export const STATE_CONFIG: Record<
  HealthState,
  {
    label: string;
    shortLabel: string;
    colorClass: string;
    bgClass: string;
    borderClass: string;
    dotClass: string;
    description: string;
  }
> = {
  strengthening: {
    label:       "Strengthening",
    shortLabel:  "Strengthening",
    colorClass:  "text-emerald-600 dark:text-emerald-400",
    bgClass:     "bg-emerald-500/8 dark:bg-emerald-950/30",
    borderClass: "border-emerald-500/20",
    dotClass:    "bg-emerald-500",
    description: "Engagement is growing. Interaction frequency and response cadence are increasing.",
  },
  stable: {
    label:       "Stable",
    shortLabel:  "Stable",
    colorClass:  "text-blue-600 dark:text-blue-400",
    bgClass:     "bg-blue-500/8 dark:bg-blue-950/30",
    borderClass: "border-blue-500/20",
    dotClass:    "bg-blue-500",
    description: "Consistent engagement. Commitments are being met. No action required.",
  },
  cooling: {
    label:       "Cooling",
    shortLabel:  "Cooling",
    colorClass:  "text-amber-600 dark:text-amber-400",
    bgClass:     "bg-amber-500/8 dark:bg-amber-950/30",
    borderClass: "border-amber-500/20",
    dotClass:    "bg-amber-500",
    description: "Engagement is declining. Response latency or interaction frequency has decreased.",
  },
  critical: {
    label:       "Critical",
    shortLabel:  "Critical",
    colorClass:  "text-red-600 dark:text-red-400",
    bgClass:     "bg-red-500/8 dark:bg-red-950/30",
    borderClass: "border-red-500/20",
    dotClass:    "bg-red-500",
    description: "Multiple concerning signals. Immediate attention is warranted.",
  },
  disengaged: {
    label:       "Disengaged",
    shortLabel:  "Disengaged",
    colorClass:  "text-muted-foreground",
    bgClass:     "bg-muted/30",
    borderClass: "border-border/50",
    dotClass:    "bg-muted-foreground/60",
    description: "Contact has gone dark. The relationship appears to have stalled.",
  },
  unknown: {
    label:       "Insufficient data",
    shortLabel:  "Unknown",
    colorClass:  "text-muted-foreground",
    bgClass:     "bg-muted/20",
    borderClass: "border-border/30",
    dotClass:    "bg-muted-foreground/30",
    description: "Not enough signal history to assess health reliably.",
  },
};

const SIGNAL_STATUS_BAR: Record<SignalStatus, string> = {
  healthy: "bg-emerald-500",
  neutral: "bg-blue-400",
  warning: "bg-amber-500",
  critical: "bg-red-500",
};

const ALERT_ICON: Record<AlertSeverity, React.ReactNode> = {
  info:     <Info className="h-3.5 w-3.5 shrink-0" />,
  warning:  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />,
  critical: <AlertCircle className="h-3.5 w-3.5 shrink-0" />,
};

const ALERT_COLOR: Record<AlertSeverity, string> = {
  info:     "text-muted-foreground",
  warning:  "text-amber-600 dark:text-amber-400",
  critical: "text-red-600 dark:text-red-400",
};

const DIMENSION_ICON: Record<HealthDimension, React.ReactNode> = {
  silence:     <Clock className="h-3 w-3" />,
  momentum:    <Activity className="h-3 w-3" />,
  commitments: <CheckSquare className="h-3 w-3" />,
  vitality:    <Zap className="h-3 w-3" />,
  depth:       <TrendingDown className="h-3 w-3" />,
};

const TREND_ICON: Record<HealthTrend, React.ReactNode> = {
  improving: <ArrowUpRight className="h-3.5 w-3.5" />,
  stable:    <Minus className="h-3.5 w-3.5" />,
  declining: <ArrowDownRight className="h-3.5 w-3.5" />,
};

// ── ThreadHealthBadge ─────────────────────────────────────────────────────────

interface ThreadHealthBadgeProps {
  health: ThreadHealth;
  /** Show the trend arrow alongside the state label. */
  showTrend?: boolean;
  /** Compact: smaller text, no border */
  compact?: boolean;
}

export function ThreadHealthBadge({
  health,
  showTrend = true,
  compact = false,
}: ThreadHealthBadgeProps) {
  const cfg = STATE_CONFIG[health.state];

  if (!health.reliable) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/60">
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30" />
        Unknown
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 font-medium",
        compact
          ? "text-[11px]"
          : "text-[12px] px-2 py-0.5 rounded-full border",
        compact ? cfg.colorClass : cn(cfg.bgClass, cfg.borderClass, cfg.colorClass)
      )}
      title={cfg.description}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", cfg.dotClass)} />
      {cfg.label}
      {showTrend && health.trend !== "stable" ? (
        <span className="opacity-70">{TREND_ICON[health.trend]}</span>
      ) : null}
    </span>
  );
}

// ── RelationshipTrendDot ──────────────────────────────────────────────────────

export function RelationshipTrendDot({ state }: { state: HealthState }) {
  const cfg = STATE_CONFIG[state];
  return (
    <span
      className={cn(
        "inline-flex h-2 w-2 rounded-full shrink-0",
        cfg.dotClass,
        state === "critical" && "animate-pulse"
      )}
      aria-label={cfg.label}
    />
  );
}

// ── SilenceIndicator ──────────────────────────────────────────────────────────

export function SilenceIndicator({
  daysSince,
  className,
}: {
  daysSince: number;
  className?: string;
}) {
  const urgency =
    daysSince > 30 ? "critical" :
    daysSince > 14 ? "warning" :
    daysSince > 7  ? "neutral" :
    "healthy";

  const label =
    daysSince === 0 ? "Today" :
    daysSince === 1 ? "Yesterday" :
    `${daysSince}d ago`;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[11px] tabular-nums",
        urgency === "critical" ? "text-red-500" :
        urgency === "warning"  ? "text-amber-500" :
        "text-muted-foreground",
        className
      )}
    >
      <Clock className="h-3 w-3" />
      {label}
    </span>
  );
}

// ── SignalBar ─────────────────────────────────────────────────────────────────

function SignalBar({ signal }: { signal: HealthSignal }) {
  const barWidth = `${signal.score}%`;
  const barColor = SIGNAL_STATUS_BAR[signal.status];

  return (
    <div className="grid grid-cols-[1fr_auto] gap-x-3 items-start py-2.5 border-b border-border/40 last:border-0">
      <div className="space-y-1.5 min-w-0">
        {/* Label row */}
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground/60">
            {DIMENSION_ICON[signal.dimension]}
          </span>
          <span className="text-[12px] font-medium text-foreground/80">
            {signal.label}
          </span>
          {signal.trend && signal.trend !== "stable" ? (
            <span
              className={cn(
                "text-[11px]",
                signal.trend === "improving"
                  ? "text-emerald-500"
                  : "text-amber-500"
              )}
            >
              {TREND_ICON[signal.trend]}
            </span>
          ) : null}
        </div>

        {/* Progress bar */}
        <div className="h-[3px] w-full rounded-full bg-muted/50 overflow-hidden">
          <div
            className={cn("h-full rounded-full transition-all duration-500", barColor)}
            style={{ width: barWidth }}
          />
        </div>

        {/* Explanation */}
        {signal.explanation ? (
          <p className="text-[11px] text-muted-foreground/70 leading-snug">
            {signal.explanation}
          </p>
        ) : null}
      </div>

      {/* Value */}
      <div className="text-right shrink-0 pt-0.5">
        <span
          className={cn(
            "text-[12px] tabular-nums",
            signal.status === "critical" ? "text-red-600 dark:text-red-400 font-medium" :
            signal.status === "warning"  ? "text-amber-600 dark:text-amber-400 font-medium" :
            "text-foreground/70"
          )}
        >
          {signal.value}
        </span>
      </div>
    </div>
  );
}

// ── RelationshipAlerts ────────────────────────────────────────────────────────

export function RelationshipAlerts({
  alerts,
  compact = false,
}: {
  alerts: HealthAlert[];
  compact?: boolean;
}) {
  if (alerts.length === 0) return null;

  // Sort: critical first
  const sorted = [...alerts].sort((a, b) => {
    const order = { critical: 0, warning: 1, info: 2 };
    return order[a.severity] - order[b.severity];
  });

  return (
    <div className={cn("space-y-1.5", compact && "space-y-1")}>
      {sorted.map((alert) => (
        <div
          key={alert.id}
          className={cn(
            "flex items-start gap-2 rounded-md px-2.5 py-2 text-xs",
            alert.severity === "critical"
              ? "bg-red-500/8 border border-red-500/20"
              : alert.severity === "warning"
              ? "bg-amber-500/8 border border-amber-500/20"
              : "bg-muted/40 border border-border/40"
          )}
        >
          <span className={cn("mt-0.5", ALERT_COLOR[alert.severity])}>
            {ALERT_ICON[alert.severity]}
          </span>
          <div className="flex-1 min-w-0 space-y-1">
            <p className={cn("leading-snug", ALERT_COLOR[alert.severity])}>
              {alert.message}
            </p>
            {alert.actionLabel && alert.actionHref && !compact ? (
              <Link
                href={alert.actionHref}
                className="inline-flex items-center gap-0.5 text-primary hover:underline font-medium text-[11px]"
              >
                {alert.actionLabel}
                <ExternalLink className="h-2.5 w-2.5" />
              </Link>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── ThreadHealthPanel ─────────────────────────────────────────────────────────

interface ThreadHealthPanelProps {
  health: ThreadHealth;
  /** Thread title for context in alerts. */
  threadTitle?: string;
  /** Show full alerts section. */
  showAlerts?: boolean;
  className?: string;
}

export function ThreadHealthPanel({
  health,
  showAlerts = true,
  className,
}: ThreadHealthPanelProps) {
  const cfg = STATE_CONFIG[health.state];
  const hasAlerts = health.alerts.length > 0;
  const criticalAlerts = health.alerts.filter((a) => a.severity === "critical");

  // Unknown / unreliable state
  if (!health.reliable) {
    return (
      <div className={cn("rounded-lg border border-border/40 bg-card/60 p-4 space-y-2", className)}>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="h-2 w-2 rounded-full bg-muted-foreground/30" />
          <span className="font-medium">Insufficient signal history</span>
        </div>
        <p className="text-[12px] text-muted-foreground/70 leading-relaxed">
          At least 2 signals over 2+ days are needed for a reliable health assessment.
          Check back once more activity has been recorded.
        </p>
      </div>
    );
  }

  return (
    <div className={cn("rounded-lg border overflow-hidden", cfg.borderClass, className)}>
      {/* Header */}
      <div className={cn("px-4 py-3 flex items-center justify-between gap-3", cfg.bgClass)}>
        <div className="flex items-center gap-2.5">
          <span className={cn("h-2 w-2 rounded-full shrink-0", cfg.dotClass,
            health.state === "critical" && "animate-pulse"
          )} />
          <span className={cn("text-sm font-semibold", cfg.colorClass)}>
            {cfg.label}
          </span>
          {criticalAlerts.length > 0 ? (
            <span className="inline-flex items-center justify-center h-4 min-w-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold">
              {criticalAlerts.length}
            </span>
          ) : null}
        </div>

        {/* Trend */}
        <div className={cn(
          "flex items-center gap-1 text-[12px] font-medium shrink-0",
          health.trend === "improving" ? "text-emerald-600 dark:text-emerald-400" :
          health.trend === "declining" ? "text-amber-600 dark:text-amber-400" :
          "text-muted-foreground"
        )}>
          {TREND_ICON[health.trend]}
          <span>
            {health.trend === "improving" ? "Improving"  :
             health.trend === "declining" ? "Declining"  :
             "Stable"}
          </span>
        </div>
      </div>

      {/* Signal bars */}
      <div className="px-4 pt-1 pb-2 bg-card/40">
        {health.signals.map((signal) => (
          <SignalBar key={signal.dimension} signal={signal} />
        ))}
      </div>

      {/* Alerts */}
      {showAlerts && hasAlerts ? (
        <div className={cn("px-3 pb-3 pt-1 border-t", cfg.borderClass, cfg.bgClass)}>
          <RelationshipAlerts alerts={health.alerts} />
        </div>
      ) : null}
    </div>
  );
}

// ── ThreadHealthSummaryLine ───────────────────────────────────────────────────

/**
 * One-liner for compact displays.
 * e.g. "● Cooling · 8d silence · 2 unresolved"
 */
export function ThreadHealthSummaryLine({ health }: { health: ThreadHealth }) {
  if (!health.reliable) {
    return <span className="text-[11px] text-muted-foreground/50">No health data</span>;
  }

  const cfg = STATE_CONFIG[health.state];
  const silenceSignal = health.signals.find((s) => s.dimension === "silence");
  const commitSignal = health.signals.find((s) => s.dimension === "commitments");

  const parts: string[] = [];
  if (silenceSignal && silenceSignal.status !== "healthy") {
    parts.push(silenceSignal.value);
  }
  if (commitSignal && commitSignal.status !== "healthy") {
    parts.push(commitSignal.value);
  }

  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[11px]", cfg.colorClass)}>
      <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", cfg.dotClass)} />
      <span className="font-medium">{cfg.label}</span>
      {parts.length > 0 ? (
        <span className="text-muted-foreground/70">
          · {parts.join(" · ")}
        </span>
      ) : null}
    </span>
  );
}

// ── RelationshipHealthRow ─────────────────────────────────────────────────────

export function RelationshipHealthRow({
  contact,
  onClick,
}: {
  contact: ContactHealth;
  onClick?: () => void;
}) {
  const cfg = STATE_CONFIG[contact.state];
  const isCritical = contact.state === "critical" || contact.state === "disengaged";

  const inner = (
    <div
      className={cn(
        "flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors group",
        isCritical ? cn("border", cfg.borderClass, cfg.bgClass) : "hover:bg-muted/30",
        onClick && "cursor-pointer"
      )}
      onClick={onClick}
    >
      {/* State dot */}
      <span className={cn(
        "h-2 w-2 rounded-full shrink-0",
        cfg.dotClass,
        isCritical && "animate-pulse"
      )} />

      {/* Name */}
      <div className="flex-1 min-w-0 space-y-0.5">
        <p className="text-[13px] font-medium text-foreground truncate">{contact.name}</p>
        {contact.primaryAlert ? (
          <p className={cn("text-[11px] leading-snug truncate", cfg.colorClass)}>
            {contact.primaryAlert}
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground/60">{cfg.label}</p>
        )}
      </div>

      {/* Right side: silence + commitments */}
      <div className="shrink-0 text-right space-y-0.5">
        {contact.daysSinceContact !== null ? (
          <SilenceIndicator daysSince={contact.daysSinceContact} />
        ) : null}
        {contact.unresolvedCommitments > 0 ? (
          <p className="text-[11px] text-amber-600 dark:text-amber-400">
            {contact.unresolvedCommitments} open
          </p>
        ) : null}
      </div>

      {onClick ? (
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40 group-hover:text-muted-foreground shrink-0 transition-colors" />
      ) : null}
    </div>
  );

  return inner;
}

// ── RelationshipHealthGrid ────────────────────────────────────────────────────

/**
 * Grid of contacts with their health state.
 * Used in the homepage relationship section and contacts page.
 */
export function RelationshipHealthGrid({
  contacts,
  title = "Relationship Health",
  viewAllHref,
}: {
  contacts: ContactHealth[];
  title?: string;
  viewAllHref?: string;
}) {
  const sorted = useMemo(() => {
    const stateOrder: Record<HealthState, number> = {
      critical:      0,
      disengaged:    1,
      cooling:       2,
      unknown:       3,
      stable:        4,
      strengthening: 5,
    };
    return [...contacts].sort((a, b) => stateOrder[a.state] - stateOrder[b.state]);
  }, [contacts]);

  const criticalCount = sorted.filter(
    (c) => c.state === "critical" || c.state === "disengaged"
  ).length;
  const coolingCount = sorted.filter((c) => c.state === "cooling").length;

  return (
    <div className="basil-card p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="basil-eyebrow text-xs">
            {title}
          </span>
          {criticalCount > 0 ? (
            <span className="inline-flex items-center justify-center h-4 min-w-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold">
              {criticalCount}
            </span>
          ) : coolingCount > 0 ? (
            <span className="inline-flex items-center justify-center h-4 min-w-4 px-1 rounded-full bg-amber-500/20 text-amber-600 dark:text-amber-400 text-[10px] font-semibold border border-amber-500/30">
              {coolingCount}
            </span>
          ) : null}
        </div>
        {viewAllHref ? (
          <Link
            href={viewAllHref}
            className="text-[11px] text-muted-foreground hover:text-primary transition-colors flex items-center gap-0.5"
          >
            All contacts
            <ArrowUpRight className="h-3 w-3" />
          </Link>
        ) : null}
      </div>

      {/* Rows */}
      {sorted.length === 0 ? (
        <p className="text-[12px] text-muted-foreground py-3 text-center">
          No contacts to assess yet
        </p>
      ) : (
        <div className="space-y-0.5 -mx-1 px-1">
          {sorted.map((contact) => (
            <RelationshipHealthRow key={contact.contactId} contact={contact} />
          ))}
        </div>
      )}

      {/* State legend */}
      <div className="pt-1 border-t border-border/40 flex flex-wrap gap-x-3 gap-y-1">
        {(["strengthening", "stable", "cooling", "critical"] as HealthState[]).map((s) => {
          const c = STATE_CONFIG[s];
          return (
            <span key={s} className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/60">
              <span className={cn("h-1.5 w-1.5 rounded-full", c.dotClass)} />
              {c.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}
