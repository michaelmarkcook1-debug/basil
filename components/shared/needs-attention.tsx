"use client";

/**
 * components/shared/needs-attention.tsx
 *
 * The lead a list page needs: how much of this actually wants you, and what to
 * open first.
 *
 * Every list surface in Basil opened on the full set — 100 Linear issues, 348
 * stalled commitments, every decision ever logged — with the pressing items
 * somewhere inside it. Sorting is not prioritisation; a page that shows
 * everything has decided nothing on your behalf.
 *
 * Counts are passed in already computed from stored records. This component
 * never derives urgency itself, so it cannot invent it.
 */

import Link from "next/link";
import { AlertTriangle, CheckCircle2 } from "lucide-react";

export interface AttentionBucket {
  label: string;
  count: number;
  /** Applies the danger treatment. Reserved for genuinely blocking states. */
  urgent?: boolean;
  onClick?: () => void;
  href?: string;
}

export function NeedsAttention({
  buckets, allClear, unavailable, className = "",
}: {
  buckets: AttentionBucket[];
  /** Shown when every bucket is zero AND the data was genuinely readable. */
  allClear?: string;
  /**
   * Set when the underlying source could not be read. Zero counts then mean
   * "unknown", not "clear" — and saying "all clear" over an outage is the one
   * failure mode this product cannot afford.
   */
  unavailable?: string;
  className?: string;
}) {
  const total = buckets.reduce((n, b) => n + b.count, 0);

  if (unavailable) {
    return (
      <div
        className={`rounded-lg border p-3.5 ${className}`}
        style={{ borderColor: "var(--w-manila)", background: "var(--w-manila-tint)" }}
      >
        <p className="flex items-start gap-2 text-[0.875rem] text-[color:var(--w-ink)]">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" style={{ color: "var(--w-manila)" }} aria-hidden />
          <span><strong className="font-semibold">Cannot tell what needs attention.</strong> {unavailable}</span>
        </p>
      </div>
    );
  }

  if (total === 0) {
    return (
      <div className={`rounded-lg border border-[var(--w-rule)] bg-[var(--w-flimsy)] p-3.5 ${className}`}>
        <p className="flex items-start gap-2 text-[0.875rem] text-[color:var(--w-ink)]">
          <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" style={{ color: "var(--w-filed)" }} aria-hidden />
          <span>{allClear ?? "Nothing needs attention."}</span>
        </p>
      </div>
    );
  }

  return (
    <div className={`rounded-lg border border-[var(--w-rule)] bg-[var(--w-flimsy)] p-3.5 ${className}`}>
      <p className="text-[0.9375rem] font-semibold text-[color:var(--w-ink)]">
        {total} need{total === 1 ? "s" : ""} attention
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {buckets.filter((b) => b.count > 0).map((b) => {
          const style = b.urgent
            ? { color: "var(--w-stamp)", background: "var(--w-stamp-tint)", borderColor: "var(--w-stamp)" }
            : { color: "var(--w-ink)", background: "var(--w-tray)", borderColor: "var(--w-rule-strong)" };
          const inner = (
            <>
              {b.urgent && <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />}
              <span>{b.label}</span>
              <span className="wire-data font-bold">{b.count}</span>
            </>
          );
          const cls =
            "inline-flex min-h-[44px] sm:min-h-[32px] items-center gap-1.5 rounded-md border px-2.5 text-[0.8125rem] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";
          if (b.href) return <Link key={b.label} href={b.href} className={cls} style={style}>{inner}</Link>;
          if (b.onClick) return <button key={b.label} type="button" onClick={b.onClick} className={cls} style={style}>{inner}</button>;
          return <span key={b.label} className={cls} style={style}>{inner}</span>;
        })}
      </div>
    </div>
  );
}
