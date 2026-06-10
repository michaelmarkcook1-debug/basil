"use client";

/**
 * Thread health visual system.
 *
 * Exports:
 *   ThreadHealthBadge      — compact state chip (thread list, contact cards)
 *   ThreadHealthPanel      — full multi-signal breakdown (thread detail)
 *   RelationshipAlerts     — operational alert list
 *   SilenceIndicator       — days-since-contact surface
 *   RelationshipTrendDot   — coloured trend dot for inline use
 *   RelationshipHealthRow  — single contact health row (relationship grid)
 *   RelationshipHealthGrid — contact health overview (homepage widget)
 *   HealthScoreArc         — SVG semicircle score gauge (scoring UI)
 *   RelationshipPulseChart — 8-bar weekly signal sparkline (trend surface)
 *   HealthStateCard        — assembled operational card (arc + signals + pulse + alerts)
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
    colorClass:  "text-signal-positive",
    bgClass:     "bg-signal-positive/8",
    borderClass: "border-signal-positive/20",
    dotClass:    "bg-signal-positive",
    description: "Engagement is growing. Interaction frequency and response cadence are increasing.",
  },
  stable: {
    label:       "Stable",
    shortLabel:  "Stable",
    colorClass:  "text-signal-info",
    bgClass:     "bg-signal-info/8",
    borderClass: "border-signal-info/20",
    dotClass:    "bg-signal-info",
    description: "Consistent engagement. Commitments are being met. No action required.",
  },
  cooling: {
    label:       "Cooling",
    shortLabel:  "Cooling",
    colorClass:  "text-signal-warning",
    bgClass:     "bg-signal-warning/8",
    borderClass: "border-signal-warning/20",
    dotClass:    "bg-signal-warning",
    description: "Engagement is declining. Response latency or interaction frequency has decreased.",
  },
  critical: {
    label:       "Critical",
    shortLabel:  "Critical",
    colorClass:  "text-signal-critical",
    bgClass:     "bg-signal-critical/8",
    borderClass: "border-signal-critical/20",
    dotClass:    "bg-signal-critical",
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
  healthy: "bg-signal-positive",
  neutral: "bg-signal-info",
  warning: "bg-signal-warning",
  critical: "bg-signal-critical",
};

const ALERT_ICON: Record<AlertSeverity, React.ReactNode> = {
  info:     <Info className="h-3.5 w-3.5 shrink-0" />,
  warning:  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />,
  critical: <AlertCircle className="h-3.5 w-3.5 shrink-0" />,
};

const ALERT_COLOR: Record<AlertSeverity, string> = {
  info:     "text-muted-foreground",
  warning:  "text-signal-warning",
  critical: "text-signal-critical",
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
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground/60">
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
          ? "text-xs"
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
        "inline-flex items-center gap-1 text-xs tabular-nums",
        urgency === "critical" ? "text-signal-critical" :
        urgency === "warning"  ? "text-signal-warning" :
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
                "text-xs",
                signal.trend === "improving"
                  ? "text-signal-positive"
                  : "text-signal-warning"
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
          <p className="text-xs text-muted-foreground/70 leading-snug">
            {signal.explanation}
          </p>
        ) : null}
      </div>

      {/* Value */}
      <div className="text-right shrink-0 pt-0.5">
        <span
          className={cn(
            "text-[12px] tabular-nums",
            signal.status === "critical" ? "text-signal-critical font-medium" :
            signal.status === "warning"  ? "text-signal-warning font-medium" :
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
              ? "bg-signal-critical/8 border border-signal-critical/20"
              : alert.severity === "warning"
              ? "bg-signal-warning/8 border border-signal-warning/20"
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
                className="inline-flex items-center gap-0.5 text-primary hover:underline font-medium text-xs"
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
            <span className="inline-flex items-center justify-center h-4 min-w-4 px-1 rounded-full bg-signal-critical text-white text-xs font-bold">
              {criticalAlerts.length}
            </span>
          ) : null}
        </div>

        {/* Trend */}
        <div className={cn(
          "flex items-center gap-1 text-[12px] font-medium shrink-0",
          health.trend === "improving" ? "text-signal-positive" :
          health.trend === "declining" ? "text-signal-warning" :
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
    return <span className="text-xs text-muted-foreground/50">No health data</span>;
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
    <span className={cn("inline-flex items-center gap-1.5 text-xs", cfg.colorClass)}>
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
          <p className={cn("text-xs leading-snug truncate", cfg.colorClass)}>
            {contact.primaryAlert}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground/60">{cfg.label}</p>
        )}
      </div>

      {/* Right side: silence + commitments */}
      <div className="shrink-0 text-right space-y-0.5">
        {contact.daysSinceContact !== null ? (
          <SilenceIndicator daysSince={contact.daysSinceContact} />
        ) : null}
        {contact.unresolvedCommitments > 0 ? (
          <p className="text-xs text-signal-warning">
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
            <span className="inline-flex items-center justify-center h-4 min-w-4 px-1 rounded-full bg-signal-critical text-white text-xs font-bold">
              {criticalCount}
            </span>
          ) : coolingCount > 0 ? (
            <span className="inline-flex items-center justify-center h-4 min-w-4 px-1 rounded-full bg-signal-warning-subtle text-signal-warning text-xs font-semibold border border-signal-warning/30">
              {coolingCount}
            </span>
          ) : null}
        </div>
        {viewAllHref ? (
          <Link
            href={viewAllHref}
            className="text-xs text-muted-foreground hover:text-primary transition-colors flex items-center gap-0.5"
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
            <span key={s} className="inline-flex items-center gap-1 text-xs text-muted-foreground/60">
              <span className={cn("h-1.5 w-1.5 rounded-full", c.dotClass)} />
              {c.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ── Arc fill colors (hex — SVG attributes can't use Tailwind classes) ─────────

const ARC_FILL: Record<HealthState, string> = {
  strengthening: "#10b981",
  stable:        "#3b82f6",
  cooling:       "#f59e0b",
  critical:      "#ef4444",
  disengaged:    "#6b7280",
  unknown:       "#9ca3af",
};

/** Zone boundary scores where health state thresholds fall. */
const ZONE_TICKS = [20, 35, 55, 75] as const;

/**
 * Maps a 0–100 health score to an (x, y) point on the upper semicircle.
 * Circle centre = (50, 50), configurable radius r.
 * Standard math angle convention: angle = π × (1 − score/100)
 * Y is negated to convert from math-coords (Y-up) to SVG-coords (Y-down).
 */
function scoreToXY(score: number, r = 40): [number, number] {
  const angle = Math.PI * (1 - score / 100);
  return [
    50 + r * Math.cos(angle),
    50 - r * Math.sin(angle),
  ];
}

// ── HealthScoreArc ────────────────────────────────────────────────────────────

interface HealthScoreArcProps {
  health: ThreadHealth;
  /**
   * Rendered pixel width. Height is automatically set to 56% of width.
   * Default 120.
   */
  size?: number;
  className?: string;
}

/**
 * SVG semicircle gauge showing relationship health at a glance.
 * The arc fills left-to-right as score increases (0 = far left, 100 = far right).
 * Zone boundary ticks mark the four state thresholds.
 */
export function HealthScoreArc({ health, size = 120, className }: HealthScoreArcProps) {
  const { state, score, trend, reliable } = health;
  const fillColor = ARC_FILL[state];
  const cfg = STATE_CONFIG[state];

  // Clamp slightly away from endpoints to avoid degenerate arcs at 0 and 100.
  const safeScore = reliable ? Math.max(0.5, Math.min(99.5, score)) : 0;
  const [ix, iy] = scoreToXY(safeScore);

  // Upper-arc fill from score=0 (10,50) to indicator position.
  // sweep-flag=1 (CW in SVG screen coords) traces the upper semicircle.
  // large-arc-flag=0 because all partial fills are < 180°.
  const fillPath =
    reliable && score > 0
      ? `M 10 50 A 40 40 0 0 1 ${ix.toFixed(2)} ${iy.toFixed(2)}`
      : "";

  return (
    <div className={cn("flex flex-col items-center gap-0.5", className)}>
      <svg
        viewBox="0 0 100 56"
        width={size}
        height={Math.round((size * 56) / 100)}
        role="img"
        aria-label={
          reliable
            ? `Relationship health: ${cfg.label}, score ${score}`
            : "Relationship health: insufficient data"
        }
      >
        {/* Background track — full upper semicircle */}
        <path
          d="M 10 50 A 40 40 0 0 1 90 50"
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.1}
          strokeWidth={4.5}
          strokeLinecap="round"
          className="text-foreground"
        />

        {/* Zone boundary ticks — radial lines at state thresholds */}
        {ZONE_TICKS.map((tickScore) => {
          const [ox, oy] = scoreToXY(tickScore, 44);
          const [tx, ty] = scoreToXY(tickScore, 36);
          return (
            <line
              key={tickScore}
              x1={tx.toFixed(2)}
              y1={ty.toFixed(2)}
              x2={ox.toFixed(2)}
              y2={oy.toFixed(2)}
              stroke="currentColor"
              strokeOpacity={0.18}
              strokeWidth={1}
              className="text-foreground"
            />
          );
        })}

        {/* Filled arc — score progress */}
        {fillPath ? (
          <path
            d={fillPath}
            fill="none"
            stroke={fillColor}
            strokeWidth={4.5}
            strokeLinecap="round"
          />
        ) : null}

        {/* Indicator: halo + dot + inner highlight */}
        {reliable ? (
          <>
            <circle
              cx={ix.toFixed(2)}
              cy={iy.toFixed(2)}
              r={5.5}
              fill={fillColor}
              opacity={0.18}
            />
            <circle cx={ix.toFixed(2)} cy={iy.toFixed(2)} r={3.5} fill={fillColor} />
            <circle cx={ix.toFixed(2)} cy={iy.toFixed(2)} r={1.5} fill="white" />
          </>
        ) : null}

        {/* Baseline end-caps */}
        <circle
          cx="10"
          cy="50"
          r="1.5"
          fill="currentColor"
          fillOpacity={0.12}
          className="text-foreground"
        />
        <circle
          cx="90"
          cy="50"
          r="1.5"
          fill="currentColor"
          fillOpacity={0.12}
          className="text-foreground"
        />
      </svg>

      {/* State + trend labels */}
      <div className="text-center leading-tight">
        <p className={cn("text-[12px] font-semibold", cfg.colorClass)}>
          {reliable ? cfg.shortLabel : "—"}
        </p>
        {reliable && trend !== "stable" ? (
          <p
            className={cn(
              "text-xs flex items-center justify-center gap-0.5 mt-0.5",
              trend === "improving"
                ? "text-signal-positive"
                : "text-signal-warning"
            )}
          >
            {TREND_ICON[trend]}
            {trend === "improving" ? "Improving" : "Declining"}
          </p>
        ) : null}
      </div>
    </div>
  );
}

// ── RelationshipPulseChart ────────────────────────────────────────────────────

interface RelationshipPulseChartProps {
  /**
   * Weekly signal counts, oldest first.
   * Will be zero-padded on the left and trimmed to exactly 8 bars.
   */
  weeklySignals: number[];
  state: HealthState;
  className?: string;
}

/**
 * Compact 8-bar sparkline showing weekly signal volume over the past 8 weeks.
 * The four most-recent bars render at full opacity; older bars are dimmed.
 * Zero-signal bars display as a minimal baseline tick.
 */
export function RelationshipPulseChart({
  weeklySignals,
  state,
  className,
}: RelationshipPulseChartProps) {
  const bars = useMemo(() => {
    const raw = [...weeklySignals];
    while (raw.length < 8) raw.unshift(0);   // pad left with zeros
    return raw.slice(-8);                     // ensure exactly 8 bars
  }, [weeklySignals]);

  const maxVal = Math.max(...bars, 1);
  const color = ARC_FILL[state];

  return (
    <div
      className={cn("flex items-end gap-[2px]", className)}
      role="img"
      aria-label="8-week signal activity"
    >
      {bars.map((val, i) => {
        const isRecent = i >= 4;
        const barH = val === 0 ? 2 : Math.max(3, Math.round((val / maxVal) * 24));
        return (
          <div
            key={i}
            style={{
              width: 6,
              height: barH,
              borderRadius: 2,
              backgroundColor: val === 0 ? "currentColor" : color,
              opacity: val === 0
                ? (isRecent ? 0.1 : 0.06)
                : (isRecent ? 1.0 : 0.4),
            }}
            className={val === 0 ? "text-foreground" : undefined}
            title={`Week ${i + 1}: ${val} signal${val !== 1 ? "s" : ""}`}
          />
        );
      })}
    </div>
  );
}

// ── HealthStateCard ───────────────────────────────────────────────────────────

interface HealthStateCardProps {
  health: ThreadHealth;
  /** Contact or thread display name shown in the card header. */
  name?: string;
  /**
   * Weekly signal counts (oldest first) for the pulse sparkline row.
   * If omitted or empty, the pulse row is hidden.
   */
  weeklySignals?: number[];
  /** Optional deep-link to the thread or contact detail page. */
  href?: string;
  className?: string;
}

/**
 * Full assembled relationship health card.
 *
 * Layout:
 *   ┌─────────────────────────────────────────┐
 *   │  ● Name          State label   Trend →  │  ← header (tinted)
 *   ├────────────┬────────────────────────────┤
 *   │            │ Silence   ·  8d ago        │
 *   │  Arc gauge │ Momentum  ·  Stable        │  ← body
 *   │            │ …                          │
 *   ├────────────┴────────────────────────────┤
 *   │  8-week  ▄ ▄ █ █ ▄ ▅ █ ▂       now     │  ← pulse (optional)
 *   ├─────────────────────────────────────────┤
 *   │  ⚠ Alert message                        │  ← alerts / clear
 *   └─────────────────────────────────────────┘
 */
export function HealthStateCard({
  health,
  name,
  weeklySignals,
  href,
  className,
}: HealthStateCardProps) {
  const cfg = STATE_CONFIG[health.state];
  const hasAlerts = health.alerts.length > 0;
  const showPulse = weeklySignals && weeklySignals.length > 0;

  return (
    <div className={cn("rounded-lg border overflow-hidden", cfg.borderClass, className)}>

      {/* ── Header ─────────────────────────────────────────────────── */}
      <div
        className={cn(
          "px-3 py-2.5 flex items-center justify-between gap-2 border-b",
          cfg.bgClass,
          cfg.borderClass
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={cn(
              "h-2 w-2 rounded-full shrink-0",
              cfg.dotClass,
              health.state === "critical" && "animate-pulse"
            )}
          />
          {name ? (
            <span className="text-[13px] font-semibold text-foreground truncate">
              {name}
            </span>
          ) : null}
          <span className={cn("text-xs font-medium shrink-0", cfg.colorClass)}>
            {health.reliable ? cfg.label : "Unknown"}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {health.reliable && health.trend !== "stable" ? (
            <span
              className={cn(
                "text-xs flex items-center gap-0.5 font-medium",
                health.trend === "improving"
                  ? "text-signal-positive"
                  : "text-signal-warning"
              )}
            >
              {TREND_ICON[health.trend]}
              <span>{health.trend === "improving" ? "Improving" : "Declining"}</span>
            </span>
          ) : null}

          {href ? (
            <Link
              href={href}
              className="text-muted-foreground/40 hover:text-muted-foreground transition-colors"
              aria-label="View full relationship details"
            >
              <ChevronRight className="h-4 w-4" />
            </Link>
          ) : null}
        </div>
      </div>

      {/* ── Body: arc + signal dimension rows ──────────────────────── */}
      <div className="p-3 bg-card/50 flex gap-4 items-start">
        {/* Score gauge */}
        <HealthScoreArc health={health} size={100} className="shrink-0" />

        {/* Signal rows */}
        <div className="flex-1 min-w-0">
          {health.reliable && health.signals.length > 0 ? (
            health.signals.map((signal) => (
              <div
                key={signal.dimension}
                className="flex items-center gap-1.5 py-[5px] border-b border-border/25 last:border-0"
              >
                <span
                  className={cn(
                    "shrink-0",
                    signal.status === "critical" ? "text-signal-critical" :
                    signal.status === "warning"  ? "text-signal-warning" :
                    signal.status === "healthy"  ? "text-signal-positive" :
                    "text-muted-foreground/40"
                  )}
                >
                  {DIMENSION_ICON[signal.dimension]}
                </span>
                <span className="flex-1 min-w-0 text-xs text-muted-foreground/70 truncate">
                  {signal.label}
                </span>
                <span
                  className={cn(
                    "text-xs tabular-nums shrink-0 font-medium",
                    signal.status === "critical" ? "text-signal-critical" :
                    signal.status === "warning"  ? "text-signal-warning" :
                    signal.status === "healthy"  ? "text-signal-positive" :
                    "text-foreground/55"
                  )}
                >
                  {signal.value}
                </span>
              </div>
            ))
          ) : (
            <p className="text-[12px] text-muted-foreground/60 py-3">
              Insufficient signal history for assessment
            </p>
          )}
        </div>
      </div>

      {/* ── Weekly pulse sparkline ──────────────────────────────────── */}
      {showPulse ? (
        <div className="px-3 py-2.5 border-t border-border/30 bg-card/30 flex items-center gap-3">
          <span className="text-xs uppercase tracking-wider text-muted-foreground/40 shrink-0 font-medium">
            8-week
          </span>
          <RelationshipPulseChart
            weeklySignals={weeklySignals!}
            state={health.state}
          />
          <span className="text-xs text-muted-foreground/40 ml-auto">now</span>
        </div>
      ) : null}

      {/* ── Alerts or clear-status footer ──────────────────────────── */}
      {hasAlerts ? (
        <div
          className={cn(
            "px-3 py-2.5 border-t space-y-1.5",
            cfg.borderClass,
            cfg.bgClass
          )}
        >
          <RelationshipAlerts alerts={health.alerts} compact />
        </div>
      ) : health.reliable ? (
        <div className="px-3 py-2 border-t border-border/25 bg-card/20">
          <p className="text-xs text-muted-foreground/50 flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-signal-positive/50 shrink-0" />
            No operational concerns
          </p>
        </div>
      ) : null}
    </div>
  );
}
