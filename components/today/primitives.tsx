"use client";

/**
 * components/today/primitives.tsx
 *
 * The vocabulary Today is built from: urgency, provenance, section frames, and
 * the honest states.
 *
 * ACCESSIBILITY CONTRACT, enforced here rather than remembered per-usage:
 * every status carries colour AND an icon AND a word. Colour alone fails for
 * roughly one in twelve men, and it fails completely in a screenshot pasted
 * into a document, which is how half of these surfaces actually get read.
 */

import type { ReactNode } from "react";
import { AlertTriangle, Clock, Eye, Radio, Sparkles } from "lucide-react";
import { URGENCY_LABEL, type Urgency, type Provenance } from "@/lib/today/executive";

// ── Urgency ──────────────────────────────────────────────────────────────────

const URGENCY_STYLE: Record<Urgency, { fg: string; bg: string; border: string; Icon: typeof AlertTriangle }> = {
  "act-now": { fg: "var(--w-stamp)",  bg: "var(--w-stamp-tint)",  border: "var(--w-stamp)",  Icon: AlertTriangle },
  today:     { fg: "var(--w-manila)", bg: "var(--w-manila-tint)", border: "var(--w-manila)", Icon: Clock },
  watch:     { fg: "var(--w-ink-soft)", bg: "var(--w-tray)",      border: "var(--w-rule-strong)", Icon: Eye },
};

export function UrgencyBadge({ urgency, className = "" }: { urgency: Urgency; className?: string }) {
  const s = URGENCY_STYLE[urgency];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[0.75rem] font-semibold border ${className}`}
      style={{ color: s.fg, background: s.bg, borderColor: s.border }}
    >
      <s.Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {URGENCY_LABEL[urgency]}
    </span>
  );
}

/** The left rule that lets you scan urgency down a column without reading. */
export function urgencyRule(urgency: Urgency): string {
  return URGENCY_STYLE[urgency].border;
}

// ── Provenance ───────────────────────────────────────────────────────────────

/**
 * Where this came from and how sure Basil is.
 *
 * Kept deliberately quiet — small, secondary ink, after the content. The old
 * design gave sourcing the same weight as the action itself, which is why the
 * page read as a database: every row announced its lineage before its point.
 * It must remain available, because an inferred claim the reader cannot audit
 * is worse than no claim; it must not lead.
 */
export function ProvenanceIndicator({
  provenance, source, at, className = "",
}: { provenance: Provenance; source: string; at?: string; className?: string }) {
  const inferred = provenance === "inferred";
  const Icon = inferred ? Sparkles : Radio;
  const when = at ? new Date(at) : null;
  const label = inferred
    ? `Inferred by Basil from ${source}`
    : `Observed directly in ${source}`;
  return (
    <span
      className={`inline-flex items-center gap-1 text-[0.6875rem] text-[color:var(--w-ink-soft)] ${className}`}
      title={label}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden />
      <span className="sr-only">{label}. </span>
      <span aria-hidden>{inferred ? "Inferred" : "Observed"} · {source}</span>
      {when && (
        <time dateTime={when.toISOString()} className="wire-data" aria-hidden>
          · {when.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
        </time>
      )}
    </span>
  );
}

// ── Section frame ────────────────────────────────────────────────────────────

export function Panel({
  title, id, action, children, className = "", as: Tag = "section",
}: {
  title: string;
  id: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  as?: "section" | "aside";
}) {
  return (
    <Tag aria-labelledby={id} className={className}>
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <h2 id={id} className="text-[0.8125rem] font-semibold uppercase tracking-[0.08em] text-[color:var(--w-carbon)]">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </Tag>
  );
}

export function Card({ children, className = "", style }: { children: ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <div
      className={`rounded-lg border border-[var(--w-rule)] bg-[var(--w-flimsy)] ${className}`}
      style={style}
    >
      {children}
    </div>
  );
}

// ── The honest states ────────────────────────────────────────────────────────

/**
 * `Unavailable` and `Empty` are DIFFERENT components on purpose.
 *
 * "Nothing needs you" and "Gmail is disconnected so Basil cannot see whether
 * anything needs you" produce an identical empty array. Rendering the second as
 * the first is a lie the reader has no way to detect, and it is the exact
 * failure this product exists to prevent.
 */
export function Unavailable({ what, why, action }: { what: string; why: string; action?: ReactNode }) {
  return (
    <Card className="p-4" style={{ borderColor: "var(--w-manila)", background: "var(--w-manila-tint)" }}>
      <p className="flex items-start gap-2 text-[0.875rem] text-[color:var(--w-ink)]">
        <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" style={{ color: "var(--w-manila)" }} aria-hidden />
        <span><strong className="font-semibold">{what} unavailable.</strong> {why}</span>
      </p>
      {action && <div className="mt-2 pl-6">{action}</div>}
    </Card>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <Card className="p-4">
      <p className="text-[0.875rem] text-[color:var(--w-ink-soft)]">{children}</p>
    </Card>
  );
}

export function Loading({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div role="status" aria-live="polite" className="space-y-2">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          aria-hidden
          className="h-16 rounded-lg border border-[var(--w-rule)] bg-[var(--w-tray)] motion-safe:animate-pulse"
        />
      ))}
    </div>
  );
}

export function Failed({ what, onRetry }: { what: string; onRetry?: () => void }) {
  return (
    <Card className="p-4" style={{ borderColor: "var(--w-stamp)", background: "var(--w-stamp-tint)" }}>
      <p className="flex items-start gap-2 text-[0.875rem] text-[color:var(--w-ink)]">
        <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" style={{ color: "var(--w-stamp)" }} aria-hidden />
        <span>
          <strong className="font-semibold">{what} could not be loaded.</strong>{" "}
          This is a failure to read, not an all-clear.
        </span>
      </p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 ml-6 min-h-[44px] sm:min-h-0 sm:py-1 px-3 rounded border border-[var(--w-stamp)] text-[0.8125rem] font-semibold text-[color:var(--w-stamp)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          Retry
        </button>
      )}
    </Card>
  );
}
