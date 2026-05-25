"use client";

/**
 * Basil Design System Primitives
 *
 * Typed React components that wrap the CSS design token classes from globals.css.
 * Use these instead of raw Tailwind classes to ensure system consistency and
 * make future token changes propagate automatically.
 *
 * Components:
 *   BasilText         — Typographic scale wrapper
 *   DataValue         — Tabular numbers with optional trend indicator
 *   OperationalCard   — Flat surface card using basil-card
 *   SectionHeader     — Eyebrow + heading + optional action slot
 *   StatusPill        — Signal-system severity badge
 *   PriorityBar       — Left-rail vertical priority indicator
 *   OperationalRow    — Horizontal data row with label/value/status
 *   Divider           — Subtle horizontal rule
 *   EmptyState        — Consistent empty / zero-data display
 */

import * as React from "react";
import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";

// ─── BasilText ────────────────────────────────────────────────────────────────

type TextLevel =
  | "display"   // basil-display  — large serif display heading
  | "heading"   // basil-heading  — section heading, sans-serif
  | "eyebrow"   // basil-eyebrow  — category label, uppercase, tracked
  | "caption"   // basil-caption  — helper text, 12px
  | "data"      // basil-data     — Geist Mono 13px, tabular
  | "data-lg"   // basil-data-lg  — Geist Mono 24px, key metric
  | "prose";    // basil-prose    — running text, 15px, 68ch

const TEXT_CLASS: Record<TextLevel, string> = {
  display: "basil-display",
  heading: "basil-heading",
  eyebrow: "basil-eyebrow",
  caption: "basil-caption",
  data: "basil-data",
  "data-lg": "basil-data-lg",
  prose: "basil-prose",
};

type TextElement = "h1" | "h2" | "h3" | "h4" | "p" | "span" | "div" | "label";

const DEFAULT_ELEMENT: Record<TextLevel, TextElement> = {
  display: "h1",
  heading: "h2",
  eyebrow: "span",
  caption: "span",
  data: "span",
  "data-lg": "span",
  prose: "p",
};

interface BasilTextProps extends React.HTMLAttributes<HTMLElement> {
  level: TextLevel;
  as?: TextElement;
  muted?: boolean;
}

export function BasilText({
  level,
  as,
  muted = false,
  className,
  children,
  ...props
}: BasilTextProps) {
  const Tag = (as ?? DEFAULT_ELEMENT[level]) as React.ElementType;
  return (
    <Tag
      className={cn(
        TEXT_CLASS[level],
        muted && "text-muted-foreground",
        className
      )}
      {...props}
    >
      {children}
    </Tag>
  );
}

// ─── DataValue ────────────────────────────────────────────────────────────────

type TrendDirection = "up" | "down" | "flat";
type TrendSentiment = "positive" | "negative" | "neutral";

interface DataValueProps extends React.HTMLAttributes<HTMLSpanElement> {
  value: React.ReactNode;
  unit?: string;
  large?: boolean;
  trend?: TrendDirection;
  trendSentiment?: TrendSentiment;
  trendLabel?: string;
  muted?: boolean;
}

const TREND_ICON: Record<TrendDirection, React.ComponentType<{ className?: string }>> = {
  up: TrendingUp,
  down: TrendingDown,
  flat: Minus,
};

/** Maps direction + sentiment to a colour class */
function trendColour(
  direction: TrendDirection,
  sentiment: TrendSentiment
): string {
  if (sentiment === "neutral") return "text-muted-foreground";
  if (sentiment === "positive") return "signal-positive";
  return "signal-critical";
}

export function DataValue({
  value,
  unit,
  large = false,
  trend,
  trendSentiment = "neutral",
  trendLabel,
  muted = false,
  className,
  ...props
}: DataValueProps) {
  const TrendIcon = trend ? TREND_ICON[trend] : null;
  const colour = trend ? trendColour(trend, trendSentiment) : "";

  return (
    <span
      className={cn(
        "inline-flex items-baseline gap-1",
        muted && "opacity-60",
        className
      )}
      {...props}
    >
      <span className={cn(large ? "basil-data-lg" : "basil-data", "[font-feature-settings:'tnum']")}>
        {value}
      </span>
      {unit && (
        <span className="basil-caption text-muted-foreground">{unit}</span>
      )}
      {TrendIcon && (
        <span
          className={cn(
            "inline-flex items-center gap-0.5 text-xs font-medium",
            colour
          )}
          aria-label={trendLabel ?? `trend ${trend}`}
        >
          <TrendIcon className="h-3 w-3" />
          {trendLabel && <span className="basil-caption">{trendLabel}</span>}
        </span>
      )}
    </span>
  );
}

// ─── OperationalCard ─────────────────────────────────────────────────────────

interface OperationalCardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Raised = slight extra background elevation, for nested panels */
  raised?: boolean;
  /** Padding preset */
  padding?: "none" | "sm" | "md" | "lg";
  /** Whether to draw an inset priority bar */
  priority?: "critical" | "warning" | "info" | "neutral";
}

const PADDING_CLASS: Record<"none" | "sm" | "md" | "lg", string> = {
  none: "",
  sm: "p-3",
  md: "p-4",
  lg: "p-6",
};

export function OperationalCard({
  raised = false,
  padding = "md",
  priority,
  className,
  children,
  ...props
}: OperationalCardProps) {
  return (
    <div
      className={cn(
        raised ? "basil-surface-raised" : "basil-card",
        PADDING_CLASS[padding],
        priority && "relative pl-5",
        className
      )}
      {...props}
    >
      {priority && (
        <span
          aria-hidden="true"
          className={cn(
            "priority-bar",
            priority === "critical" && "priority-bar-critical",
            priority === "warning" && "priority-bar-warning",
            priority === "info" && "priority-bar-info",
            priority === "neutral" && "priority-bar-neutral"
          )}
        />
      )}
      {children}
    </div>
  );
}

// ─── SectionHeader ────────────────────────────────────────────────────────────

interface SectionHeaderProps {
  eyebrow?: string;
  title: React.ReactNode;
  description?: string;
  action?: React.ReactNode;
  className?: string;
  /** Tighter spacing variant for dense layouts */
  compact?: boolean;
}

export function SectionHeader({
  eyebrow,
  title,
  description,
  action,
  className,
  compact = false,
}: SectionHeaderProps) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4",
        compact ? "mb-3" : "mb-5",
        className
      )}
    >
      <div className="min-w-0">
        {eyebrow && (
          <BasilText level="eyebrow" as="span" className="block mb-1 text-muted-foreground">
            {eyebrow}
          </BasilText>
        )}
        <BasilText
          level="heading"
          as="h2"
          className={cn(compact && "text-base")}
        >
          {title}
        </BasilText>
        {description && (
          <BasilText level="caption" as="p" muted className="mt-1">
            {description}
          </BasilText>
        )}
      </div>
      {action && (
        <div className="shrink-0 flex items-center gap-2">{action}</div>
      )}
    </div>
  );
}

// ─── StatusPill ───────────────────────────────────────────────────────────────

type SignalLevel = "critical" | "warning" | "positive" | "info" | "neutral";

interface StatusPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  level: SignalLevel;
  label: string;
  /** Show a dot before the label */
  dot?: boolean;
  /** Use the subtle surface variant */
  subtle?: boolean;
}

const SIGNAL_TEXT: Record<SignalLevel, string> = {
  critical: "signal-critical",
  warning: "signal-warning",
  positive: "signal-positive",
  info: "signal-info",
  neutral: "signal-neutral",
};

const SIGNAL_SURFACE: Record<SignalLevel, string> = {
  critical: "signal-surface-critical",
  warning: "signal-surface-warning",
  positive: "signal-surface-positive",
  info: "signal-surface-info",
  neutral: "signal-surface-neutral",
};

export function StatusPill({
  level,
  label,
  dot = false,
  subtle = true,
  className,
  ...props
}: StatusPillProps) {
  return (
    <span
      role="status"
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm font-medium text-[0.6875rem] tracking-[0.04em] uppercase",
        subtle ? SIGNAL_SURFACE[level] : "bg-current/10",
        SIGNAL_TEXT[level],
        className
      )}
      {...props}
    >
      {dot && (
        <span
          aria-hidden="true"
          className="inline-block w-1.5 h-1.5 rounded-full bg-current"
        />
      )}
      {label}
    </span>
  );
}

// ─── PriorityBar ──────────────────────────────────────────────────────────────

interface PriorityBarProps {
  level: "critical" | "warning" | "info" | "neutral";
  className?: string;
  /** Explicit height; defaults to h-full (fills parent) */
  heightClass?: string;
}

export function PriorityBar({
  level,
  className,
  heightClass = "h-full",
}: PriorityBarProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "priority-bar",
        level === "critical" && "priority-bar-critical",
        level === "warning" && "priority-bar-warning",
        level === "info" && "priority-bar-info",
        level === "neutral" && "priority-bar-neutral",
        heightClass,
        className
      )}
    />
  );
}

// ─── OperationalRow ───────────────────────────────────────────────────────────

interface OperationalRowProps {
  label: string;
  value: React.ReactNode;
  /** Optional status element aligned to the right */
  status?: React.ReactNode;
  /** Renders a subtle border-bottom separator */
  separator?: boolean;
  className?: string;
}

export function OperationalRow({
  label,
  value,
  status,
  separator = false,
  className,
}: OperationalRowProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 py-2.5",
        separator && "border-b border-[var(--surface-border)] last:border-0",
        className
      )}
    >
      <BasilText level="caption" as="span" muted className="shrink-0">
        {label}
      </BasilText>
      <div className="flex items-center gap-2 ml-auto">
        <span className="basil-data text-sm">{value}</span>
        {status}
      </div>
    </div>
  );
}

// ─── Divider ─────────────────────────────────────────────────────────────────

interface DividerProps {
  /** Optional label centred on the divider */
  label?: string;
  className?: string;
}

export function Divider({ label, className }: DividerProps) {
  if (!label) {
    return (
      <hr
        className={cn(
          "border-0 border-t border-[var(--surface-border)]",
          className
        )}
      />
    );
  }
  return (
    <div
      className={cn(
        "flex items-center gap-3",
        className
      )}
      role="separator"
    >
      <hr className="flex-1 border-0 border-t border-[var(--surface-border)]" />
      <BasilText level="eyebrow" as="span" muted>
        {label}
      </BasilText>
      <hr className="flex-1 border-0 border-t border-[var(--surface-border)]" />
    </div>
  );
}

// ─── EmptyState ───────────────────────────────────────────────────────────────

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
  /** Compact variant for use inside panels */
  compact?: boolean;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  compact = false,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "py-8 gap-2" : "py-16 gap-3",
        className
      )}
    >
      {icon && (
        <div className="text-muted-foreground/40 mb-1">{icon}</div>
      )}
      <BasilText level="heading" as="h3" className={cn(compact && "text-sm font-medium")}>
        {title}
      </BasilText>
      {description && (
        <BasilText level="prose" muted className="max-w-[36ch] text-sm">
          {description}
        </BasilText>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

// ─── LoadingSkeleton ──────────────────────────────────────────────────────────

interface LoadingSkeletonProps {
  /** Number of rows to show */
  rows?: number;
  /** Show a heading skeleton above the rows */
  showHeading?: boolean;
  className?: string;
}

export function LoadingSkeleton({
  rows = 3,
  showHeading = false,
  className,
}: LoadingSkeletonProps) {
  return (
    <div className={cn("space-y-3", className)} aria-busy="true" aria-label="Loading">
      {showHeading && (
        <div className="basil-skeleton h-5 w-40 rounded mb-5" />
      )}
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="basil-skeleton h-4 rounded flex-1" />
          <div
            className="basil-skeleton h-4 rounded"
            style={{ width: `${48 + (i % 3) * 16}px` }}
          />
        </div>
      ))}
    </div>
  );
}

// ─── MotionToken ──────────────────────────────────────────────────────────────
// Convenience — re-export motion duration/ease tokens for use in inline styles

export const motion = {
  dur: {
    micro: "var(--dur-micro)",
    quick: "var(--dur-quick)",
    reveal: "var(--dur-reveal)",
    exit: "var(--dur-exit)",
    layout: "var(--dur-layout)",
    deliberate: "var(--dur-deliberate)",
  },
  ease: {
    standard: "var(--ease-standard)",
    decelerate: "var(--ease-decelerate)",
    accelerate: "var(--ease-accelerate)",
    sharp: "var(--ease-sharp)",
  },
} as const;
