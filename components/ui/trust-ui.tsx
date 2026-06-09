/**
 * Basil Trust UI — component system for TrustEnvelope visualisation.
 *
 * Answers three questions clearly and calmly:
 *   "Based on what?"        → CorroborationPanel / CorroborationBlock / ProvenanceTrail
 *   "How fresh?"            → FreshnessTag / FreshnessDecayBar
 *   "Is there a conflict?"  → ContradictionCard / ContradictionAlert
 *
 * Design principles:
 *   - Progressive disclosure: compact by default, detail on demand
 *   - Natural language, not numbers: "High confidence" not "87%"
 *   - Time expressions, not scores: "Updated 12m ago" not "0.92 freshness"
 *   - Calm visual language: trust is infrastructure, not a feature to shout about
 *   - Never fabricate: if there's no signal, say so honestly
 *
 * Component hierarchy (simplest → most complete):
 *   TrustDot               — single coloured dot, 6px
 *   TrustTierBadge         — tier dot + label chip
 *   FreshnessTag           — smart relative-time freshness
 *   FreshnessDecayBar      — visual position on decay curve
 *   ConfidenceMeter        — labelled thin bar, 0–100%
 *   CorroborationBlock     — source chips with "Corroborated across" header
 *   CorroborationPanel     — combined confidence + sources + freshness card
 *   ContradictionAlert     — inline conflict warning (embeddable)
 *   ContradictionCard      — standalone conflict card (detail views)
 *   ProvenanceTrail        — expandable chain-of-custody list
 *   TrustSummaryLine       — single-line composite for space-constrained use
 *   TrustStatusRow         — row with dot, label, sources, freshness
 *   TrustPanel             — full composite card
 *   TrustBannerCard        — full-width trust state banner
 *   TrustInlineIndicator   — dot trigger → Popover with compact TrustPanel
 *   TrustReviewPrompt      — extracted "Basil extracted this" review UX
 *   NoSignalState          — honest empty state
 *   TrustExplainerPanel    — onboarding/settings explainer
 */

"use client";

import React, { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Shield,
  ShieldCheck,
  Clock,
  Link2,
  ChevronDown,
  ChevronUp,
  HelpCircle,
  Mail,
  Hash,
  Calendar,
  Video,
  Database,
  Globe,
  MessageSquare,
  ThumbsUp,
  X,
  ArrowRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { SourceChip } from "@/components/ui/trust-badge";
import type {
  TrustEnvelope,
  TrustTier,
  Provenance,
  ContradictionFlag,
} from "@/core/primitives/trust-envelope";
import { effectiveConfidence } from "@/core/primitives/trust-envelope";

// ── Module-level constants ────────────────────────────────────────────────────

const TIER_CFG: Record<
  TrustTier,
  {
    label: string;
    dotClass: string;
    textClass: string;
    bgClass: string;
    borderClass: string;
    icon: React.ReactNode;
  }
> = {
  auto: {
    label: "Verified",
    dotClass: "bg-emerald-500",
    textClass: "text-emerald-600 dark:text-emerald-400",
    bgClass: "bg-emerald-50/60 dark:bg-emerald-950/20",
    borderClass: "border-emerald-200/60 dark:border-emerald-800/40",
    icon: <ShieldCheck className="h-3.5 w-3.5" />,
  },
  review: {
    label: "Under review",
    dotClass: "bg-amber-500",
    textClass: "text-amber-600 dark:text-amber-400",
    bgClass: "bg-amber-50/60 dark:bg-amber-950/20",
    borderClass: "border-amber-200/60 dark:border-amber-800/40",
    icon: <Shield className="h-3.5 w-3.5" />,
  },
  blocked: {
    label: "Low confidence",
    dotClass: "bg-red-500",
    textClass: "text-red-600 dark:text-red-400",
    bgClass: "bg-red-50/60 dark:bg-red-950/20",
    borderClass: "border-red-200/60 dark:border-red-800/40",
    icon: <AlertTriangle className="h-3.5 w-3.5" />,
  },
};

/** Source icon mapping — used in `SourceIconChip`. */
const SOURCE_ICONS: Record<string, React.ReactNode> = {
  gmail:    <Mail className="h-2.5 w-2.5" />,
  outlook:  <Mail className="h-2.5 w-2.5" />,
  email:    <Mail className="h-2.5 w-2.5" />,
  slack:    <Hash className="h-2.5 w-2.5" />,
  teams:    <Hash className="h-2.5 w-2.5" />,
  calendar: <Calendar className="h-2.5 w-2.5" />,
  gcal:     <Calendar className="h-2.5 w-2.5" />,
  zoom:     <Video className="h-2.5 w-2.5" />,
  linear:   <Database className="h-2.5 w-2.5" />,
  drive:    <Globe className="h-2.5 w-2.5" />,
  onedrive: <Globe className="h-2.5 w-2.5" />,
  whatsapp: <MessageSquare className="h-2.5 w-2.5" />,
};

function getSourceIcon(source: string): React.ReactNode {
  const key = source.toLowerCase().split(":")[0];
  return SOURCE_ICONS[key] ?? <Globe className="h-2.5 w-2.5" />;
}

/** Derive confidence display config from a 0–1 value. */
function confidenceCfg(value: number) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  if (pct >= 75)
    return {
      pct,
      label: "High confidence",
      barClass: "bg-emerald-500",
      textClass: "text-emerald-600 dark:text-emerald-400",
      level: "high" as const,
    };
  if (pct >= 50)
    return {
      pct,
      label: "Medium confidence",
      barClass: "bg-amber-500",
      textClass: "text-amber-600 dark:text-amber-400",
      level: "medium" as const,
    };
  return {
    pct,
    label: "Low confidence",
    barClass: "bg-red-500",
    textClass: "text-red-600 dark:text-red-400",
    level: "low" as const,
  };
}

/** Convert an ISO timestamp to a professional relative label. */
function relLabel(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days === 1) return "Yesterday";
    if (days < 7) return `${days} days ago`;
    if (days < 14) return "Last week";
    if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
    return "Last month";
  } catch {
    return "—";
  }
}

/** Deduplicate provenance by source — show each source once. */
function dedupeProvenance(provenance: Provenance[]): Provenance[] {
  const seen = new Set<string>();
  return provenance.filter((p) => {
    if (seen.has(p.source)) return false;
    seen.add(p.source);
    return true;
  });
}

const EXTRACTOR_LABEL: Record<Provenance["extractedBy"], string> = {
  ai: "AI",
  rule: "Rule",
  human: "Manual",
};

const MODEL_TIER_LABEL: Record<string, string> = {
  fast: "fast",
  balanced: "balanced",
  deep: "deep",
};

// Separator used inline between trust summary elements
const DOT_SEP = (
  <span className="text-muted-foreground/30 text-xs select-none" aria-hidden>
    ·
  </span>
);

// ── TrustDot ──────────────────────────────────────────────────────────────────
// The most compact trust indicator. A single colored dot.

export interface TrustDotProps {
  tier: TrustTier;
  /** Default 6px. Pass "lg" for 8px. */
  size?: "sm" | "lg";
  className?: string;
}

export function TrustDot({ tier, size = "sm", className }: TrustDotProps) {
  const { dotClass } = TIER_CFG[tier];
  return (
    <span
      className={cn(
        "inline-block rounded-full shrink-0",
        size === "lg" ? "h-2 w-2" : "h-1.5 w-1.5",
        dotClass,
        className
      )}
      aria-label={TIER_CFG[tier].label}
    />
  );
}

// ── TrustTierBadge ────────────────────────────────────────────────────────────
// Tier dot + label. Standard trust indicator for most contexts.

export interface TrustTierBadgeProps {
  tier: TrustTier;
  showLabel?: boolean;
  className?: string;
}

export function TrustTierBadge({
  tier,
  showLabel = true,
  className,
}: TrustTierBadgeProps) {
  const { label, dotClass, textClass } = TIER_CFG[tier];
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", dotClass)} />
      {showLabel && (
        <span className={cn("text-xs font-medium", textClass)}>{label}</span>
      )}
    </span>
  );
}

// ── ConfidenceMeter ───────────────────────────────────────────────────────────
// Thin labelled bar. Use in detail views.

export interface ConfidenceMeterProps {
  value: number;
  showLabel?: boolean;
  showPercent?: boolean;
  className?: string;
}

export function ConfidenceMeter({
  value,
  showLabel = true,
  showPercent = false,
  className,
}: ConfidenceMeterProps) {
  const cfg = confidenceCfg(value);
  return (
    <div className={cn("space-y-1.5", className)}>
      {showLabel && (
        <div className="flex items-center justify-between gap-2">
          <span className={cn("text-xs font-medium", cfg.textClass)}>
            {cfg.label}
          </span>
          {showPercent && (
            <span className={cn("text-xs font-mono tabular-nums", cfg.textClass)}>
              {cfg.pct}%
            </span>
          )}
        </div>
      )}
      <div className="h-[2px] w-full rounded-full bg-border/50">
        <div
          className={cn("h-full rounded-full transition-all duration-300", cfg.barClass)}
          style={{ width: `${cfg.pct}%` }}
        />
      </div>
    </div>
  );
}

// ── FreshnessTag ──────────────────────────────────────────────────────────────
// Smart relative-time indicator. Color shifts as signal ages.

export interface FreshnessTagProps {
  createdAt: string;
  lastCorroboratedAt?: string;
  halfLifeDays?: number;
  className?: string;
}

export function FreshnessTag({
  createdAt,
  lastCorroboratedAt,
  halfLifeDays,
  className,
}: FreshnessTagProps) {
  const referenceDate = lastCorroboratedAt ?? createdAt;
  const ageDays = (Date.now() - new Date(referenceDate).getTime()) / 86_400_000;
  const isAging = halfLifeDays !== undefined && ageDays > halfLifeDays * 0.5;
  const isStale = halfLifeDays !== undefined && ageDays > halfLifeDays;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs",
        isStale
          ? "text-amber-600 dark:text-amber-400"
          : isAging
          ? "text-muted-foreground/80"
          : "text-muted-foreground",
        className
      )}
    >
      <Clock className="h-3 w-3 shrink-0" />
      Updated {relLabel(referenceDate)}
    </span>
  );
}

// ── FreshnessDecayBar ─────────────────────────────────────────────────────────
// Visual decay curve. Shows where the signal sits between fresh and stale.
// Position marker moves right as the signal ages past its half-life.

export interface FreshnessDecayBarProps {
  createdAt: string;
  lastCorroboratedAt?: string;
  halfLifeDays: number;
  className?: string;
}

export function FreshnessDecayBar({
  createdAt,
  lastCorroboratedAt,
  halfLifeDays,
  className,
}: FreshnessDecayBarProps) {
  const referenceDate = lastCorroboratedAt ?? createdAt;
  const ageDays = (Date.now() - new Date(referenceDate).getTime()) / 86_400_000;

  // Normalize position: 0 = fresh, 1 = at 2× half-life (fully stale for display)
  const maxDisplay = halfLifeDays * 2;
  const position = Math.min(1, ageDays / maxDisplay);
  const positionPct = Math.round(position * 100);

  // Color the filled portion green → amber → red based on position
  const fillClass =
    position < 0.25 ? "bg-emerald-500"
    : position < 0.55 ? "bg-amber-400"
    : "bg-red-400";

  // Label at current position
  const label =
    position < 0.25 ? "Fresh"
    : position < 0.55 ? "Aging"
    : "Stale";

  const labelColorClass =
    position < 0.25 ? "text-emerald-600 dark:text-emerald-400"
    : position < 0.55 ? "text-amber-600 dark:text-amber-400"
    : "text-red-500";

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground/50">Fresh</span>
        <span className={cn("font-medium", labelColorClass)}>{label}</span>
        <span className="text-muted-foreground/50">Stale</span>
      </div>
      <div className="relative h-1.5 w-full rounded-full bg-border/40">
        {/* Filled track up to current position */}
        <div
          className={cn("h-full rounded-full transition-all duration-300", fillClass)}
          style={{ width: `${positionPct}%` }}
        />
        {/* Position marker */}
        <div
          className={cn(
            "absolute top-1/2 -translate-y-1/2 h-3 w-3 rounded-full border-2 border-background shadow-sm transition-all duration-300",
            position < 0.25 ? "bg-emerald-500"
            : position < 0.55 ? "bg-amber-400"
            : "bg-red-400"
          )}
          style={{ left: `calc(${positionPct}% - 6px)` }}
        />
      </div>
      <div className="text-xs text-muted-foreground tabular-nums">
        {relLabel(referenceDate)} · half-life {halfLifeDays}d
      </div>
    </div>
  );
}

// ── SourceIconChip ────────────────────────────────────────────────────────────
// Source chip with an icon. Richer than the plain-text SourceChip.
// Used inside CorroborationPanel and ProvenanceTrail.

interface SourceIconChipProps {
  source: string;
  className?: string;
}

function SourceIconChip({ source, className }: SourceIconChipProps) {
  const icon = getSourceIcon(source);
  const label = source.includes(":")
    ? source.split(":")[0].charAt(0).toUpperCase() + source.split(":")[0].slice(1)
    : source.charAt(0).toUpperCase() + source.slice(1);

  // Use SourceChip from trust-badge for consistent coloring + label
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <SourceChip source={source} />
    </span>
  );
}

// ── CorroborationBlock ────────────────────────────────────────────────────────
// Shows which sources have contributed to this signal.

export interface CorroborationBlockProps {
  provenance: Provenance[];
  corroborationCount?: number;
  layout?: "inline" | "list";
  className?: string;
}

export function CorroborationBlock({
  provenance,
  corroborationCount,
  layout = "inline",
  className,
}: CorroborationBlockProps) {
  const unique = dedupeProvenance(provenance);
  if (unique.length === 0) return null;

  const count = corroborationCount ?? unique.length;
  const isCorroborated = count > 1;
  const heading = isCorroborated ? "Corroborated across" : "Source";

  if (layout === "list") {
    return (
      <div className={cn("space-y-2", className)}>
        <p className="basil-eyebrow">{heading}</p>
        <div className="space-y-1.5">
          {unique.map((p) => (
            <div key={p.source} className="flex items-center gap-2">
              <SourceChip source={p.source} />
              <span className="text-xs text-muted-foreground">
                {relLabel(p.extractedAt)}
              </span>
              <span className="text-xs text-muted-foreground/60">
                via {EXTRACTOR_LABEL[p.extractedBy]}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("space-y-1.5", className)}>
      <p className="basil-eyebrow">{heading}</p>
      <div className="flex items-center gap-1.5 flex-wrap">
        {unique.map((p) => (
          <SourceChip key={p.source} source={p.source} />
        ))}
      </div>
    </div>
  );
}

// ── CorroborationPanel ────────────────────────────────────────────────────────
// The primary trust display for detail views — matches the brief's example:
//
//   High confidence
//   Corroborated across:
//     [Gmail]  [Slack]  [Calendar]
//   Updated 12m ago
//
// Self-contained card variant of CorroborationBlock + ConfidenceMeter + FreshnessTag.

export interface CorroborationPanelProps {
  envelope: TrustEnvelope;
  /** Show the confidence meter bar. Default: true */
  showMeter?: boolean;
  /** "card" = bordered card, "flat" = no border/background. Default: "card" */
  variant?: "card" | "flat";
  className?: string;
}

export function CorroborationPanel({
  envelope,
  showMeter = true,
  variant = "card",
  className,
}: CorroborationPanelProps) {
  const eff = effectiveConfidence(envelope);
  const cfg = confidenceCfg(eff);
  const unique = dedupeProvenance(envelope.provenance);
  const isCorroborated = unique.length > 1;
  const referenceDate = envelope.lastCorroboratedAt ?? envelope.createdAt;

  return (
    <div
      className={cn(
        variant === "card"
          ? "rounded-xl border border-border/60 bg-card/60 px-4 py-3.5"
          : "",
        "space-y-3",
        className
      )}
    >
      {/* Confidence label + freshness on same row */}
      <div className="flex items-center justify-between gap-3">
        <span className={cn("text-[13px] font-semibold", cfg.textClass)}>
          {cfg.label}
        </span>
        <FreshnessTag
          createdAt={envelope.createdAt}
          lastCorroboratedAt={envelope.lastCorroboratedAt}
          halfLifeDays={envelope.decayHalfLifeDays}
        />
      </div>

      {/* Confidence bar */}
      {showMeter && (
        <div className="h-[2px] w-full rounded-full bg-border/50">
          <div
            className={cn("h-full rounded-full transition-all", cfg.barClass)}
            style={{ width: `${cfg.pct}%` }}
          />
        </div>
      )}

      {/* Sources */}
      {unique.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
            {isCorroborated ? "Corroborated across" : "Source"}
          </p>
          <div className="flex items-center gap-1.5 flex-wrap">
            {unique.map((p) => (
              <SourceChip key={p.source} source={p.source} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── ContradictionAlert ────────────────────────────────────────────────────────
// Inline embeddable conflict warning. Compact — use inside cards.

export interface ResolvedConflict {
  field: string;
  severity: "low" | "medium" | "high";
  sourceA: string;
  valueA: string;
  sourceB: string;
  valueB: string;
}

export interface ContradictionAlertProps {
  conflicts?: ResolvedConflict[];
  flags?: ContradictionFlag[];
  className?: string;
}

export function ContradictionAlert({
  conflicts,
  flags,
  className,
}: ContradictionAlertProps) {
  const hasResolved = (conflicts?.length ?? 0) > 0;
  const hasFlags = (flags?.length ?? 0) > 0;
  if (!hasResolved && !hasFlags) return null;

  const isHighSeverity =
    conflicts?.some((c) => c.severity === "high") ??
    flags?.some((f) => f.severity === "high") ??
    false;

  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2.5 space-y-2.5",
        isHighSeverity
          ? "border-red-200/70 bg-red-50/50 dark:border-red-800/40 dark:bg-red-950/20"
          : "border-amber-200/70 bg-amber-50/50 dark:border-amber-800/40 dark:bg-amber-950/20",
        className
      )}
    >
      <div className="flex items-center gap-2">
        <AlertTriangle
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            isHighSeverity ? "text-red-500" : "text-amber-500"
          )}
        />
        <span
          className={cn(
            "text-[12px] font-semibold",
            isHighSeverity
              ? "text-red-700 dark:text-red-400"
              : "text-amber-700 dark:text-amber-400"
          )}
        >
          Conflict detected
        </span>
        {(conflicts?.length ?? 0) > 1 && (
          <span
            className={cn(
              "text-xs font-mono",
              isHighSeverity
                ? "text-red-600/60 dark:text-red-500/60"
                : "text-amber-600/60 dark:text-amber-500/60"
            )}
          >
            {conflicts!.length} conflicts
          </span>
        )}
      </div>

      {hasResolved &&
        conflicts!.map((c, i) => (
          <ConflictRow key={i} conflict={c} />
        ))}

      {!hasResolved &&
        hasFlags &&
        flags!.map((f, i) => (
          <div key={i} className="pl-5">
            <p className="text-[12px] text-foreground/75">
              Conflict on:{" "}
              <span className="font-medium text-foreground/90">{f.field}</span>
              {f.severity === "high" && (
                <span className="ml-1.5 text-xs text-red-500">(high severity)</span>
              )}
            </p>
          </div>
        ))}
    </div>
  );
}

// Extracted per rerender-no-inline-components rule
function ConflictRow({ conflict: c }: { conflict: ResolvedConflict }) {
  return (
    <div className="space-y-1 pl-5">
      {c.field && <p className="basil-eyebrow">{c.field}</p>}
      <div className="flex items-center gap-2 text-[12px]">
        <SourceChip source={c.sourceA} />
        <span className="text-foreground/75">indicates</span>
        <span className="font-medium text-foreground/90">{c.valueA}</span>
      </div>
      <div className="flex items-center gap-2 text-[12px]">
        <SourceChip source={c.sourceB} />
        <span className="text-foreground/75">indicates</span>
        <span className="font-medium text-foreground/90">{c.valueB}</span>
      </div>
    </div>
  );
}

// ── ContradictionCard ─────────────────────────────────────────────────────────
// Standalone conflict display — more prominent than ContradictionAlert.
// Use in detail views where trust conflict is a primary concern.
//
// Contradiction detected
// ─────────────────────
// Status
//   [Slack] indicates  approved
//   [Email] indicates  blocked

export interface ContradictionCardProps {
  conflicts: ResolvedConflict[];
  /** "card" = full bordered card, "strip" = left-bordered strip. Default: "card" */
  variant?: "card" | "strip";
  /** Show a dismiss button. Calls onDismiss when clicked. */
  onDismiss?: () => void;
  className?: string;
}

export function ContradictionCard({
  conflicts,
  variant = "card",
  onDismiss,
  className,
}: ContradictionCardProps) {
  if (conflicts.length === 0) return null;

  const isHighSeverity = conflicts.some((c) => c.severity === "high");
  const borderColor = isHighSeverity
    ? "border-red-300/60 dark:border-red-700/40"
    : "border-amber-300/60 dark:border-amber-700/40";
  const bgColor = isHighSeverity
    ? "bg-red-50/40 dark:bg-red-950/15"
    : "bg-amber-50/40 dark:bg-amber-950/15";
  const accentColor = isHighSeverity
    ? "bg-red-500"
    : "bg-amber-500";
  const headingColor = isHighSeverity
    ? "text-red-700 dark:text-red-400"
    : "text-amber-700 dark:text-amber-400";

  return (
    <div
      className={cn(
        variant === "card"
          ? cn("rounded-xl border", borderColor, bgColor, "px-4 py-3.5")
          : cn("border-l-2", accentColor, "pl-4 py-1"),
        "space-y-3",
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AlertTriangle
            className={cn(
              "h-3.5 w-3.5 shrink-0",
              isHighSeverity ? "text-red-500" : "text-amber-500"
            )}
          />
          <span className={cn("text-[12px] font-semibold tracking-wide", headingColor)}>
            {conflicts.length === 1 ? "Contradiction detected" : `${conflicts.length} contradictions detected`}
          </span>
        </div>
        {onDismiss && (
          <button
            onClick={onDismiss}
            className="text-muted-foreground/50 hover:text-muted-foreground transition-colors"
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Conflicts */}
      <div className="space-y-4">
        {conflicts.map((c, i) => (
          <ConflictDetail key={i} conflict={c} />
        ))}
      </div>
    </div>
  );
}

// Extracted per rerender-no-inline-components rule
function ConflictDetail({ conflict: c }: { conflict: ResolvedConflict }) {
  return (
    <div className="space-y-2">
      {c.field && (
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-muted-foreground/60">
          {c.field}
        </p>
      )}
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        {/* Source A */}
        <div className="rounded-md border border-border/60 bg-card/60 px-2.5 py-2 space-y-1">
          <SourceChip source={c.sourceA} />
          <p className="text-[12px] font-medium text-foreground">{c.valueA}</p>
        </div>

        {/* VS divider */}
        <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground/50">
          vs
        </span>

        {/* Source B */}
        <div className="rounded-md border border-border/60 bg-card/60 px-2.5 py-2 space-y-1">
          <SourceChip source={c.sourceB} />
          <p className="text-[12px] font-medium text-foreground">{c.valueB}</p>
        </div>
      </div>
    </div>
  );
}

// ── ProvenanceTrail ───────────────────────────────────────────────────────────
// Expandable chain-of-custody. Shows each source with timestamp + confidence.

export interface ProvenanceTrailProps {
  provenance: Provenance[];
  defaultExpanded?: boolean;
  className?: string;
}

export function ProvenanceTrail({
  provenance,
  defaultExpanded = false,
  className,
}: ProvenanceTrailProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (provenance.length === 0) return null;

  const count = provenance.length;
  const summary = count === 1 ? "1 source" : `${count} sources`;

  return (
    <div className={cn("space-y-1.5", className)}>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors group"
        aria-expanded={expanded}
      >
        <Link2 className="h-3 w-3 shrink-0 opacity-50 group-hover:opacity-70 transition-opacity" />
        <span>{summary}</span>
        {expanded ? (
          <ChevronUp className="h-2.5 w-2.5" />
        ) : (
          <ChevronDown className="h-2.5 w-2.5" />
        )}
      </button>

      {expanded && (
        <div className="ml-1 pl-3 border-l border-border/60 space-y-3">
          {provenance.map((p, i) => {
            const cfg = confidenceCfg(p.confidence);
            const modelNote =
              p.modelTier !== undefined
                ? ` · ${MODEL_TIER_LABEL[p.modelTier] ?? p.modelTier}`
                : "";
            return (
              <div key={i} className="space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <SourceChip source={p.source} />
                  <span className="text-xs text-muted-foreground tabular-nums font-mono">
                    {relLabel(p.extractedAt)}
                  </span>
                  <span className="text-xs text-muted-foreground/60">
                    {EXTRACTOR_LABEL[p.extractedBy]}{modelNote}
                  </span>
                </div>
                <div className="flex items-center gap-2 pl-0.5">
                  <div className="h-[2px] w-10 rounded-full bg-border/50 overflow-hidden">
                    <div
                      className={cn("h-full rounded-full", cfg.barClass)}
                      style={{ width: `${cfg.pct}%` }}
                    />
                  </div>
                  <span className={cn("text-xs font-mono tabular-nums", cfg.textClass)}>
                    {cfg.pct}%
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── TrustSummaryLine ──────────────────────────────────────────────────────────
// Single-line composite for space-constrained contexts.

export interface TrustSummaryLineProps {
  envelope: TrustEnvelope;
  className?: string;
}

export function TrustSummaryLine({ envelope, className }: TrustSummaryLineProps) {
  const eff = effectiveConfidence(envelope);
  const cfg = confidenceCfg(eff);
  const unique = dedupeProvenance(envelope.provenance);
  const hasConflict = envelope.contradictionFlags.length > 0;

  return (
    <div className={cn("flex items-center gap-2 flex-wrap", className)}>
      <TrustTierBadge tier={envelope.trustTier} />
      {DOT_SEP}
      <span className={cn("text-xs font-medium", cfg.textClass)}>
        {cfg.label}
      </span>
      {unique.length > 0 && (
        <>
          {DOT_SEP}
          <span className="flex items-center gap-1">
            {unique.map((p) => (
              <SourceChip key={p.source} source={p.source} />
            ))}
          </span>
        </>
      )}
      {DOT_SEP}
      <FreshnessTag
        createdAt={envelope.createdAt}
        lastCorroboratedAt={envelope.lastCorroboratedAt}
        halfLifeDays={envelope.decayHalfLifeDays}
      />
      {hasConflict && (
        <>
          {DOT_SEP}
          <span className="inline-flex items-center gap-1 text-xs text-amber-500 dark:text-amber-400">
            <AlertTriangle className="h-2.5 w-2.5" />
            Conflict
          </span>
        </>
      )}
    </div>
  );
}

// ── TrustStatusRow ────────────────────────────────────────────────────────────
// A formatted row variant of TrustSummaryLine — icon-bearing tier, source chips,
// freshness — designed for use as a bottom row on any card.

export interface TrustStatusRowProps {
  envelope: TrustEnvelope;
  /** Show the source chips. Default: true */
  showSources?: boolean;
  className?: string;
}

export function TrustStatusRow({
  envelope,
  showSources = true,
  className,
}: TrustStatusRowProps) {
  const eff = effectiveConfidence(envelope);
  const cfg = confidenceCfg(eff);
  const unique = dedupeProvenance(envelope.provenance);
  const tier = TIER_CFG[envelope.trustTier];
  const hasConflict = envelope.contradictionFlags.length > 0;

  return (
    <div
      className={cn(
        "flex items-center gap-2 pt-2 mt-2 border-t border-border/30 flex-wrap",
        className
      )}
    >
      {/* Tier icon + label */}
      <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", tier.textClass)}>
        {tier.icon}
        {tier.label}
      </span>

      {DOT_SEP}

      {/* Confidence label */}
      <span className={cn("text-xs", cfg.textClass)}>{cfg.label}</span>

      {/* Sources */}
      {showSources && unique.length > 0 && (
        <>
          {DOT_SEP}
          <span className="flex items-center gap-1 flex-wrap">
            {unique.map((p) => (
              <SourceChip key={p.source} source={p.source} />
            ))}
          </span>
        </>
      )}

      {/* Freshness */}
      {DOT_SEP}
      <FreshnessTag
        createdAt={envelope.createdAt}
        lastCorroboratedAt={envelope.lastCorroboratedAt}
        halfLifeDays={envelope.decayHalfLifeDays}
      />

      {/* Conflict warning */}
      {hasConflict && (
        <span className="ml-auto inline-flex items-center gap-1 text-xs text-amber-500">
          <AlertTriangle className="h-2.5 w-2.5" />
          Conflict
        </span>
      )}
    </div>
  );
}

// ── TrustPanel ────────────────────────────────────────────────────────────────
// Full composite trust display.

export interface TrustPanelProps {
  envelope: TrustEnvelope;
  resolvedConflicts?: ResolvedConflict[];
  showMeter?: boolean;
  showCorroboration?: boolean;
  showProvenance?: boolean;
  compact?: boolean;
  className?: string;
}

export function TrustPanel({
  envelope,
  resolvedConflicts,
  showMeter = true,
  showCorroboration = true,
  showProvenance = true,
  compact = false,
  className,
}: TrustPanelProps) {
  const eff = effectiveConfidence(envelope);
  const hasContradictions =
    envelope.contradictionFlags.length > 0 ||
    (resolvedConflicts?.length ?? 0) > 0;

  return (
    <div
      className={cn(
        compact
          ? "space-y-3"
          : "rounded-xl border border-border/60 bg-card/60 px-4 py-3.5 space-y-4",
        className
      )}
    >
      {/* Tier + freshness */}
      <div className="flex items-center justify-between gap-3">
        <TrustTierBadge tier={envelope.trustTier} />
        <FreshnessTag
          createdAt={envelope.createdAt}
          lastCorroboratedAt={envelope.lastCorroboratedAt}
          halfLifeDays={envelope.decayHalfLifeDays}
        />
      </div>

      {showMeter && (
        <ConfidenceMeter value={eff} showLabel showPercent={!compact} />
      )}

      {showCorroboration && envelope.provenance.length > 0 && (
        <CorroborationBlock
          provenance={envelope.provenance}
          corroborationCount={envelope.corroborationCount}
          layout="inline"
        />
      )}

      {hasContradictions && (
        <ContradictionAlert
          conflicts={resolvedConflicts}
          flags={envelope.contradictionFlags}
        />
      )}

      {showProvenance && envelope.provenance.length > 0 && (
        <ProvenanceTrail provenance={envelope.provenance} />
      )}
    </div>
  );
}

// ── TrustBannerCard ───────────────────────────────────────────────────────────
// Full-width trust state banner for pages or sections where trust is a
// primary concern. More prominent than TrustPanel — intended to lead a section.
//
// Three variants:
//   "verified"  — high-confidence, corroborated (emerald accent)
//   "uncertain" — review tier or low confidence (amber accent)
//   "conflict"  — contradiction detected (red accent)

export type TrustBannerVariant = "verified" | "uncertain" | "conflict";

export interface TrustBannerCardProps {
  variant: TrustBannerVariant;
  envelope: TrustEnvelope;
  /** The entity this trust state applies to, e.g. "the decision", "this action". */
  subject?: string;
  resolvedConflicts?: ResolvedConflict[];
  /** Show the expandable provenance trail. Default: true */
  showProvenance?: boolean;
  className?: string;
}

const BANNER_CFG: Record<
  TrustBannerVariant,
  {
    accentClass: string;
    bgClass: string;
    borderClass: string;
    label: string;
    sublabel: (subject?: string) => string;
    icon: React.ReactNode;
  }
> = {
  verified: {
    accentClass: "bg-emerald-500",
    bgClass: "bg-emerald-50/40 dark:bg-emerald-950/15",
    borderClass: "border-emerald-200/50 dark:border-emerald-800/30",
    label: "Verified",
    sublabel: (s) => `${s ?? "This signal"} has been corroborated across multiple sources.`,
    icon: <ShieldCheck className="h-4 w-4" />,
  },
  uncertain: {
    accentClass: "bg-amber-400",
    bgClass: "bg-amber-50/40 dark:bg-amber-950/15",
    borderClass: "border-amber-200/50 dark:border-amber-800/30",
    label: "Needs review",
    sublabel: (s) => `${s ?? "This signal"} was extracted with lower confidence and needs verification.`,
    icon: <Shield className="h-4 w-4" />,
  },
  conflict: {
    accentClass: "bg-red-500",
    bgClass: "bg-red-50/40 dark:bg-red-950/15",
    borderClass: "border-red-200/50 dark:border-red-800/30",
    label: "Contradiction detected",
    sublabel: (s) => `${s ?? "Sources"} disagree — review the conflicting signals below.`,
    icon: <AlertTriangle className="h-4 w-4" />,
  },
};

export function TrustBannerCard({
  variant,
  envelope,
  subject,
  resolvedConflicts,
  showProvenance = true,
  className,
}: TrustBannerCardProps) {
  const [detailOpen, setDetailOpen] = useState(false);
  const eff = effectiveConfidence(envelope);
  const cfg = BANNER_CFG[variant];
  const unique = dedupeProvenance(envelope.provenance);

  return (
    <div
      className={cn(
        "rounded-xl border overflow-hidden",
        cfg.bgClass,
        cfg.borderClass,
        className
      )}
    >
      {/* Accent bar */}
      <div className={cn("h-0.5 w-full", cfg.accentClass)} />

      <div className="px-4 py-3.5 space-y-3">
        {/* Header row */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span
              className={cn(
                "shrink-0",
                variant === "verified"
                  ? "text-emerald-600 dark:text-emerald-400"
                  : variant === "uncertain"
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-red-600 dark:text-red-400"
              )}
            >
              {cfg.icon}
            </span>
            <div>
              <p
                className={cn(
                  "text-[13px] font-semibold",
                  variant === "verified"
                    ? "text-emerald-700 dark:text-emerald-400"
                    : variant === "uncertain"
                    ? "text-amber-700 dark:text-amber-400"
                    : "text-red-700 dark:text-red-400"
                )}
              >
                {cfg.label}
              </p>
              <p className="text-[12px] text-muted-foreground mt-0.5">
                {cfg.sublabel(subject)}
              </p>
            </div>
          </div>

          <button
            onClick={() => setDetailOpen((v) => !v)}
            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 shrink-0 transition-colors"
          >
            {detailOpen ? "Less" : "Detail"}
            {detailOpen ? (
              <ChevronUp className="h-2.5 w-2.5" />
            ) : (
              <ChevronDown className="h-2.5 w-2.5" />
            )}
          </button>
        </div>

        {/* Compact summary row — always visible */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Confidence label */}
          <ConfidenceMeter value={eff} showLabel={false} className="w-16 shrink-0" />
          <span className={cn("text-xs font-medium", confidenceCfg(eff).textClass)}>
            {confidenceCfg(eff).label}
          </span>

          {unique.length > 0 && (
            <>
              {DOT_SEP}
              <span className="flex items-center gap-1">
                {unique.map((p) => (
                  <SourceChip key={p.source} source={p.source} />
                ))}
              </span>
            </>
          )}

          {DOT_SEP}
          <FreshnessTag
            createdAt={envelope.createdAt}
            lastCorroboratedAt={envelope.lastCorroboratedAt}
            halfLifeDays={envelope.decayHalfLifeDays}
          />
        </div>

        {/* Expanded detail */}
        {detailOpen && (
          <div className="pt-2 border-t border-border/30 space-y-3">
            {/* Corroboration */}
            {unique.length > 0 && (
              <CorroborationBlock
                provenance={envelope.provenance}
                corroborationCount={envelope.corroborationCount}
                layout="list"
              />
            )}

            {/* Contradictions */}
            {(envelope.contradictionFlags.length > 0 || (resolvedConflicts?.length ?? 0) > 0) && (
              <ContradictionAlert
                conflicts={resolvedConflicts}
                flags={envelope.contradictionFlags}
              />
            )}

            {/* Provenance trail */}
            {showProvenance && (
              <ProvenanceTrail provenance={envelope.provenance} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── TrustInlineIndicator ──────────────────────────────────────────────────────
// A small dot that opens a Popover with compact TrustPanel on hover.

export interface TrustInlineIndicatorProps {
  envelope: TrustEnvelope;
  resolvedConflicts?: ResolvedConflict[];
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
}

export function TrustInlineIndicator({
  envelope,
  resolvedConflicts,
  side = "top",
  className,
}: TrustInlineIndicatorProps) {
  const [open, setOpen] = useState(false);
  const hasConflict = envelope.contradictionFlags.length > 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "inline-flex items-center gap-1 rounded-sm px-1 py-0.5 transition-colors",
            "hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            className
          )}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          aria-label={`Trust: ${TIER_CFG[envelope.trustTier].label}`}
        >
          <TrustDot tier={envelope.trustTier} />
          {hasConflict && (
            <AlertTriangle className="h-2.5 w-2.5 text-amber-500" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side={side}
        sideOffset={6}
        align="start"
        className="w-72 p-0 bg-card border-border/80 shadow-lg"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        <TrustPanel
          envelope={envelope}
          resolvedConflicts={resolvedConflicts}
          compact
          showProvenance={false}
          className="px-3 py-3"
        />
      </PopoverContent>
    </Popover>
  );
}

// ── TrustReviewPrompt ─────────────────────────────────────────────────────────
// "Basil extracted this — looks right?" pattern.
// Extracted from the actions page for consistent use across all artifact types.

export interface TrustReviewPromptProps {
  /** Type of artifact being reviewed. */
  artifactType?: "action" | "decision" | "memory" | "signal";
  /** Additional context shown before the Confirm/Dismiss buttons. */
  extractionNote?: string;
  onConfirm: () => void;
  onDismiss: () => void;
  confirming?: boolean;
  className?: string;
}

export function TrustReviewPrompt({
  artifactType = "signal",
  extractionNote,
  onConfirm,
  onDismiss,
  confirming = false,
  className,
}: TrustReviewPromptProps) {
  const labels: Record<string, { confirm: string; dismiss: string; prompt: string }> = {
    action:   { confirm: "Confirm action",   dismiss: "Dismiss",  prompt: "Basil extracted this action — looks right?" },
    decision: { confirm: "Confirm decision", dismiss: "Dismiss",  prompt: "Basil extracted this decision — looks right?" },
    memory:   { confirm: "Save note",        dismiss: "Discard",  prompt: "Basil inferred this — worth keeping?" },
    signal:   { confirm: "Confirm",          dismiss: "Dismiss",  prompt: "Basil extracted this — looks right?" },
  };

  const l = labels[artifactType] ?? labels.signal;

  return (
    <div
      className={cn(
        "rounded-lg border border-amber-200/60 bg-amber-50/40 dark:border-amber-800/40 dark:bg-amber-950/15 px-3 py-2.5",
        "flex items-center gap-3 flex-wrap",
        className
      )}
    >
      <Shield className="h-3.5 w-3.5 text-amber-500 shrink-0" />
      <span className="text-[12px] text-amber-700 dark:text-amber-400 flex-1 min-w-0">
        {extractionNote ?? l.prompt}
      </span>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={onConfirm}
          disabled={confirming}
          className={cn(
            "inline-flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium transition-colors",
            "bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200/70",
            "dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-800/50 dark:hover:bg-emerald-950/50",
            "disabled:opacity-50"
          )}
        >
          <ThumbsUp className="h-2.5 w-2.5" />
          {confirming ? "Confirming…" : l.confirm}
        </button>
        <button
          onClick={onDismiss}
          className={cn(
            "inline-flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium transition-colors",
            "bg-red-50 text-red-600 hover:bg-red-100 border border-red-200/70",
            "dark:bg-red-950/30 dark:text-red-400 dark:border-red-800/50 dark:hover:bg-red-950/50"
          )}
        >
          <X className="h-2.5 w-2.5" />
          {l.dismiss}
        </button>
      </div>
    </div>
  );
}

// ── NoSignalState ─────────────────────────────────────────────────────────────
// Honest empty state when there's no trust data to show.

export function NoSignalState({
  message,
  className,
}: {
  message?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-[12px] text-muted-foreground italic",
        className
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30 shrink-0" />
      {message ?? "No signal"}
    </span>
  );
}

// ── TrustExplainerPanel ───────────────────────────────────────────────────────
// Standalone explainer for onboarding / settings contexts.

export function TrustExplainerPanel({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border/60 bg-card/60 px-4 py-4 space-y-4",
        className
      )}
    >
      <div className="flex items-center gap-2">
        <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/60" />
        <p className="text-[12px] font-medium text-foreground">
          How Basil determines confidence
        </p>
      </div>

      <div className="space-y-3">
        <TierExplainerRow
          tier="auto"
          description="Basil materialised this automatically — confidence was high enough to act without review."
        />
        <TierExplainerRow
          tier="review"
          description="Basil surfaced this for your attention — it needs a quick check before being treated as fact."
        />
        <TierExplainerRow
          tier="blocked"
          description="Confidence was too low to surface — unknown sender, ambiguous content, or insufficient signal."
        />
      </div>

      <div className="pt-1 border-t border-border/40">
        <p className="text-xs text-muted-foreground leading-relaxed">
          Confidence is a composite of source quality, extraction accuracy, and
          signal freshness. It decays over time — older signals are less certain.
        </p>
      </div>
    </div>
  );
}

// Extracted per rerender-no-inline-components rule
function TierExplainerRow({
  tier,
  description,
}: {
  tier: TrustTier;
  description: string;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <TrustTierBadge tier={tier} showLabel className="shrink-0 pt-0.5" />
      <p className="text-xs text-muted-foreground leading-relaxed">
        {description}
      </p>
    </div>
  );
}

// ── Re-exports ─────────────────────────────────────────────────────────────────
export { SourceChip } from "@/components/ui/trust-badge";
export { parseSourceRef } from "@/components/ui/trust-badge";
export type { TrustEnvelope, TrustTier, Provenance, ContradictionFlag };
