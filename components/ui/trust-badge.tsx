/**
 * Basil Trust UX — shared components for showing evidence and confidence.
 *
 * Every intelligence card uses these primitives to answer:
 *   "Based on what?"  → SourceChip / SourceList
 *   "How fresh?"      → FreshnessLine
 *   "How confident?"  → ConfidenceLabel
 *   "Why?"            → EvidencePanel (expandable)
 *
 * Key principle: never fabricate confidence. If signalCount is 0, show
 * "No signal" honestly rather than a fake confidence label.
 */

"use client";

import React, { useState } from "react";
import { ChevronDown, ChevronUp, Info } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Source parsing ──────────────────────────────────────────────────────────────

type KnownSource =
  | "Gmail"
  | "Calendar"
  | "Slack"
  | "Zoom"
  | "WhatsApp"
  | "Microsoft"
  | "Manual"
  | "Chat";

const SOURCE_STYLES: Record<KnownSource, string> = {
  Gmail:     "bg-red-50   text-red-700   border-red-200",
  Calendar:  "bg-blue-50  text-blue-700  border-blue-200",
  Slack:     "bg-green-50 text-green-700 border-green-200",
  Zoom:      "bg-sky-50   text-sky-700   border-sky-200",
  WhatsApp:  "bg-teal-50  text-teal-700  border-teal-200",
  Microsoft: "bg-indigo-50 text-indigo-700 border-indigo-200",
  Manual:    "bg-slate-50 text-slate-600  border-slate-200",
  Chat:      "bg-violet-50 text-violet-700 border-violet-200",
};

/** Parse a sourceRef string like "gmail:1abc2def" → human-readable label. */
export function parseSourceRef(ref: string | undefined): string {
  if (!ref) return "Unknown";
  const prefix = ref.split(":")[0].toLowerCase();
  const map: Record<string, string> = {
    gmail:     "Gmail",
    calendar:  "Calendar",
    gcal:      "Calendar",
    slack:     "Slack",
    zoom:      "Zoom",
    whatsapp:  "WhatsApp",
    microsoft: "Microsoft",
    outlook:   "Microsoft",
    teams:     "Microsoft",
    manual:    "Manual",
    chat:      "Chat",
  };
  const label = map[prefix];
  if (label) return label;
  // Capitalise unknown prefix as fallback
  return prefix.charAt(0).toUpperCase() + prefix.slice(1);
}

/** Map a source label to its known display name. */
function toKnown(label: string): KnownSource {
  const known: KnownSource[] = ["Gmail", "Calendar", "Slack", "Zoom", "WhatsApp", "Microsoft", "Manual", "Chat"];
  return (known.find((k) => k.toLowerCase() === label.toLowerCase()) ?? "Manual") as KnownSource;
}

// ── SourceChip ─────────────────────────────────────────────────────────────────

interface SourceChipProps {
  /** Human-readable source label (e.g. "Gmail") or a raw sourceRef (e.g. "gmail:1abc"). */
  source: string;
  className?: string;
}

/**
 * Small colored pill identifying a signal source.
 * Accepts either a plain label ("Gmail") or a raw sourceRef ("gmail:1abc").
 */
export function SourceChip({ source, className }: SourceChipProps) {
  const label = source.includes(":") ? parseSourceRef(source) : source;
  const known = toKnown(label);
  const style = SOURCE_STYLES[known] ?? SOURCE_STYLES.Manual;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0 text-[11px] font-medium",
        style,
        className,
      )}
    >
      {label}
    </span>
  );
}

// ── SourceList ─────────────────────────────────────────────────────────────────

interface SourceListProps {
  /** Primary source ref or label. */
  sourceRef?: string;
  /** Additional source refs accumulated from deduplication. */
  additionalSourceRefs?: string[];
  className?: string;
}

/**
 * Renders one or more SourceChips from a sourceRef + additionalSourceRefs pair.
 * Deduplicates by label so "Gmail · Gmail" never appears.
 */
export function SourceList({ sourceRef, additionalSourceRefs, className }: SourceListProps) {
  const all = [
    ...(sourceRef ? [sourceRef] : []),
    ...(additionalSourceRefs ?? []),
  ];
  if (all.length === 0) return null;

  // Deduplicate by resolved label
  const seen = new Set<string>();
  const unique = all.filter((ref) => {
    const label = parseSourceRef(ref);
    if (seen.has(label)) return false;
    seen.add(label);
    return true;
  });

  return (
    <span className={cn("flex items-center gap-1 flex-wrap", className)}>
      {unique.map((ref) => (
        <SourceChip key={ref} source={ref} />
      ))}
    </span>
  );
}

// ── FreshnessLine ──────────────────────────────────────────────────────────────

interface FreshnessLineProps {
  generatedAt?: string;
  /** ISO date of the most recent signal item, if known. */
  lastSignalAt?: string;
  timezone?: string;
  className?: string;
}

/** One-line freshness display: "Generated Tue 5 May · 09:14" */
export function FreshnessLine({ generatedAt, lastSignalAt, timezone = "Europe/London", className }: FreshnessLineProps) {
  if (!generatedAt && !lastSignalAt) return null;

  const fmtDateTime = (iso: string) =>
    new Date(iso).toLocaleString("en-GB", {
      timeZone: timezone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });

  return (
    <span className={cn("text-[11px] text-muted-foreground", className)}>
      {generatedAt && <>Generated {fmtDateTime(generatedAt)}</>}
      {lastSignalAt && generatedAt && <span className="mx-1">·</span>}
      {lastSignalAt && <>Last signal {fmtDateTime(lastSignalAt)}</>}
    </span>
  );
}

// ── ConfidenceLabel ────────────────────────────────────────────────────────────

interface ConfidenceLabelProps {
  confidence?: number;
  /** If signalCount is 0, show "No signal" even if confidence is set. */
  signalCount?: number;
  className?: string;
}

/**
 * Inline confidence label: "High confidence", "Medium confidence",
 * "Low confidence", or "No signal" when signalCount is zero.
 *
 * Never fabricates confidence when there is no signal.
 */
export function ConfidenceLabel({ confidence, signalCount, className }: ConfidenceLabelProps) {
  if (signalCount !== undefined && signalCount === 0) {
    return (
      <span className={cn("text-[11px] text-muted-foreground italic", className)}>
        No signal
      </span>
    );
  }
  if (confidence === undefined) return null;

  const pct = Math.round(confidence * 100);
  const { label, cls } =
    pct >= 80
      ? { label: "High confidence",   cls: "text-emerald-700" }
      : pct >= 60
        ? { label: "Medium confidence", cls: "text-amber-600"   }
        : { label: "Low confidence",    cls: "text-red-500"     };

  return (
    <span className={cn("text-[11px] font-medium", cls, className)}>
      {label}
    </span>
  );
}

// ── SignalSummary ──────────────────────────────────────────────────────────────

interface SignalSummaryProps {
  counts: {
    emails?:        number;
    slackMessages?: number;
    zoomSummaries?: number;
    todayEvents?:   number;
    openActions?:   number;
    activeDecisions?: number;
    recentMemories?: number;
  };
  className?: string;
}

/**
 * Compact signal count line for briefings and digests:
 * "7 emails · 12 Slack · 3 meetings · 2 Zoom"
 *
 * Only shows non-zero counts.
 */
export function SignalSummary({ counts, className }: SignalSummaryProps) {
  const parts: string[] = [];
  if (counts.emails)          parts.push(`${counts.emails} email${counts.emails !== 1 ? "s" : ""}`);
  if (counts.slackMessages)   parts.push(`${counts.slackMessages} Slack`);
  if (counts.todayEvents)     parts.push(`${counts.todayEvents} meeting${counts.todayEvents !== 1 ? "s" : ""}`);
  if (counts.zoomSummaries)   parts.push(`${counts.zoomSummaries} Zoom recap${counts.zoomSummaries !== 1 ? "s" : ""}`);
  if (counts.openActions)     parts.push(`${counts.openActions} action${counts.openActions !== 1 ? "s" : ""}`);
  if (counts.activeDecisions) parts.push(`${counts.activeDecisions} decision${counts.activeDecisions !== 1 ? "s" : ""}`);
  if (counts.recentMemories)  parts.push(`${counts.recentMemories} note${counts.recentMemories !== 1 ? "s" : ""}`);

  if (parts.length === 0) {
    return (
      <span className={cn("text-[11px] text-muted-foreground italic", className)}>
        No signal sources — regenerate after connecting your tools
      </span>
    );
  }

  return (
    <span className={cn("text-[11px] text-muted-foreground", className)}>
      Based on: {parts.join(" · ")}
    </span>
  );
}

// ── EvidencePanel ──────────────────────────────────────────────────────────────

interface EvidencePanelProps {
  /** Primary source ref or label. */
  sourceRef?: string;
  /** Additional accumulated sources. */
  additionalSourceRefs?: string[];
  /** 0–1 confidence value. */
  confidence?: number;
  /** Free-form context string (e.g. email subject, Slack channel, meeting name). */
  context?: string;
  /** Show a compact trigger inline (default). Set false for standalone usage. */
  triggerInline?: boolean;
  className?: string;
}

/**
 * Expandable "Why am I seeing this?" panel.
 *
 * Shows:
 *   - Source chips (Gmail, Slack, etc.)
 *   - Confidence (if set)
 *   - Context string (email subject, Slack channel, etc.)
 *
 * Honest: if there are no sources and no context, it renders nothing.
 */
export function EvidencePanel({
  sourceRef,
  additionalSourceRefs,
  confidence,
  context,
  triggerInline = true,
  className,
}: EvidencePanelProps) {
  const [open, setOpen] = useState(false);

  const allRefs = [
    ...(sourceRef ? [sourceRef] : []),
    ...(additionalSourceRefs ?? []),
  ];
  const hasContent = allRefs.length > 0 || confidence !== undefined || context;
  if (!hasContent) return null;

  const pct = confidence !== undefined ? Math.round(confidence * 100) : undefined;
  const confidenceLabel =
    pct === undefined
      ? null
      : pct >= 80
        ? "High confidence"
        : pct >= 60
          ? "Medium confidence"
          : "Low confidence";
  const confidenceCls =
    pct === undefined
      ? ""
      : pct >= 80
        ? "text-emerald-700"
        : pct >= 60
          ? "text-amber-600"
          : "text-red-500";

  return (
    <div className={cn("mt-1.5", className)}>
      {triggerInline && (
        <button
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          aria-expanded={open}
        >
          <Info className="h-3 w-3" />
          Why?
          {open ? <ChevronUp className="h-2.5 w-2.5" /> : <ChevronDown className="h-2.5 w-2.5" />}
        </button>
      )}

      {(open || !triggerInline) && (
        <div className="mt-1 rounded-md border border-border/50 bg-muted/30 px-3 py-2 text-[11px] space-y-1.5">
          {allRefs.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-muted-foreground">Sources:</span>
              <SourceList sourceRef={sourceRef} additionalSourceRefs={additionalSourceRefs} />
            </div>
          )}
          {confidenceLabel && (
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground">Confidence:</span>
              <span className={cn("font-medium", confidenceCls)}>{confidenceLabel} ({pct}%)</span>
            </div>
          )}
          {context && (
            <div className="flex items-start gap-1.5">
              <span className="text-muted-foreground shrink-0">Context:</span>
              <span className="text-foreground/75 italic">{context}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
