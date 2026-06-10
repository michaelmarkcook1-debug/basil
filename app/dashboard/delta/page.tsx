"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  CheckCheck,
  RefreshCw,
  ArrowRight,
  TrendingUp,
  Clock,
  AlertTriangle,
  Users,
  Zap,
  Activity,
  Shield,
  ChevronRight,
  Circle,
} from "lucide-react";
import type {
  ChangeEvent,
  ChangeCategory,
  ChangeSeverity,
  ChangesResponse,
} from "@/lib/delta/types";
import { CATEGORY_CONFIG } from "@/lib/delta/types";
import { useMode } from "@/components/ui/mode-context";

// ── Design tokens (module-level) ──────────────────────────────────────────────

const SEVERITY_CONFIG: Record<
  ChangeSeverity,
  { bar: string; barWidth: string; bg?: string; ring?: string }
> = {
  critical: {
    bar: "bg-signal-critical",
    barWidth: "w-1",
    bg: "bg-signal-critical/[0.04]",
    ring: "ring-1 ring-signal-critical/15",
  },
  high: {
    bar: "bg-signal-warning",
    barWidth: "w-[3px]",
  },
  medium: {
    bar: "bg-signal-info",
    barWidth: "w-[3px]",
  },
  low: {
    bar: "bg-muted-foreground/25",
    barWidth: "w-[2px]",
  },
};

const CATEGORY_ICON_EL: Record<ChangeCategory, React.ReactNode> = {
  urgency:      <AlertTriangle className="h-2.5 w-2.5" />,
  relationship: <Users className="h-2.5 w-2.5" />,
  operational:  <Zap className="h-2.5 w-2.5" />,
  confidence:   <Shield className="h-2.5 w-2.5" />,
  momentum:     <TrendingUp className="h-2.5 w-2.5" />,
};

const CATEGORY_ICON_SM: Record<ChangeCategory, React.ReactNode> = {
  urgency:      <AlertTriangle className="h-3 w-3" />,
  relationship: <Users className="h-3 w-3" />,
  operational:  <Zap className="h-3 w-3" />,
  confidence:   <Shield className="h-3 w-3" />,
  momentum:     <TrendingUp className="h-3 w-3" />,
};

const CATEGORY_ORDER: ChangeCategory[] = [
  "urgency",
  "relationship",
  "operational",
  "confidence",
  "momentum",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 2) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "Yesterday";
  return `${days}d ago`;
}

function sinceLabel(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const hrs = Math.round(diff / 3_600_000);
  if (hrs < 2) return "the last hour";
  if (hrs < 24) return `last ${hrs} hours`;
  const days = Math.round(hrs / 24);
  if (days === 1) return "last 24 hours";
  if (days < 7) return `last ${days} days`;
  return "last 7 days";
}

// ── Sub-components ────────────────────────────────────────────────────────────

function DeltaChip({ delta }: { delta: ChangeEvent["delta"] }) {
  const { from, to } = delta;
  if (!from && !to) return null;
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-muted/60 text-xs font-mono text-muted-foreground">
      {from && <span className="opacity-60">{from}</span>}
      {from && to && (
        <ArrowRight className="h-2.5 w-2.5 opacity-40 shrink-0" />
      )}
      {to && <span className="text-foreground/80">{to}</span>}
    </span>
  );
}

function CategoryBadge({ category }: { category: ChangeCategory }) {
  const cfg = CATEGORY_CONFIG[category];
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium ${cfg.bgClass} ${cfg.colorClass}`}
    >
      {CATEGORY_ICON_EL[category]}
      {cfg.label}
    </span>
  );
}

function UnseenDot() {
  return (
    <span
      className="absolute top-2.5 right-2.5 h-1.5 w-1.5 rounded-full bg-primary"
      aria-label="Unseen"
    />
  );
}

function ChangeCard({ event }: { event: ChangeEvent }) {
  const sev = SEVERITY_CONFIG[event.severity];
  const inner = (
    <div
      className={[
        "relative pl-4 pr-3 py-3 rounded-lg transition-colors group",
        "hover:bg-muted/30",
        sev.bg ?? "",
        sev.ring ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Severity accent bar */}
      <div
        className={`absolute left-0 top-0 bottom-0 rounded-l-lg ${sev.bar} ${sev.barWidth}`}
        aria-hidden
      />

      {/* Unseen indicator */}
      {!event.seen && <UnseenDot />}

      <div className="space-y-1.5">
        {/* Title + time */}
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm font-medium text-foreground leading-snug pr-4">
            {event.title}
          </p>
          <span className="shrink-0 text-xs text-muted-foreground whitespace-nowrap flex items-center gap-1 mt-0.5">
            <Clock className="h-2.5 w-2.5" />
            {relTime(event.occurredAt)}
          </span>
        </div>

        {/* Context */}
        <p className="text-xs text-muted-foreground leading-relaxed">
          {event.context}
        </p>

        {/* Implication */}
        {event.implication ? (
          <p
            className={`text-xs font-medium ${CATEGORY_CONFIG[event.category].colorClass}`}
          >
            {event.implication}
          </p>
        ) : null}

        {/* Footer: delta chip + category badge + link */}
        <div className="flex items-center gap-2 flex-wrap pt-0.5">
          <DeltaChip delta={event.delta} />
          <CategoryBadge category={event.category} />
          {event.entityHref ? (
            <span className="ml-auto inline-flex items-center gap-0.5 text-xs text-muted-foreground/50 group-hover:text-primary transition-colors">
              View
              <ChevronRight className="h-3 w-3" />
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );

  if (event.entityHref) {
    return (
      <Link href={event.entityHref} className="block">
        {inner}
      </Link>
    );
  }
  return inner;
}

function CategoryFilterBar({
  changes,
  active,
  onSelect,
}: {
  changes: ChangeEvent[];
  active: ChangeCategory | null;
  onSelect: (cat: ChangeCategory | null) => void;
}) {
  const counts = changes.reduce(
    (acc, e) => {
      acc[e.category] = (acc[e.category] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  const totalUnseen = changes.filter((e) => !e.seen).length;

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {/* All pill */}
      <button
        onClick={() => onSelect(null)}
        className={[
          "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all",
          active === null
            ? "bg-foreground text-background shadow-sm"
            : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground",
        ].join(" ")}
      >
        All
        {totalUnseen > 0 && active === null ? (
          <span className="h-4 min-w-4 flex items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold px-1">
            {totalUnseen}
          </span>
        ) : null}
      </button>

      {CATEGORY_ORDER.map((cat) => {
        const count = counts[cat] ?? 0;
        if (count === 0) return null;
        const cfg = CATEGORY_CONFIG[cat];
        const isActive = active === cat;
        const unseenInCat = changes.filter(
          (e) => e.category === cat && !e.seen
        ).length;
        return (
          <button
            key={cat}
            onClick={() => onSelect(isActive ? null : cat)}
            className={[
              "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-all",
              isActive
                ? `${cfg.bgClass} ${cfg.colorClass} border-current/20 shadow-sm`
                : "bg-muted/40 text-muted-foreground border-transparent hover:bg-muted hover:text-foreground",
            ].join(" ")}
          >
            {CATEGORY_ICON_SM[cat]}
            {cfg.label}
            <span
              className={`font-semibold ${isActive ? "" : "text-foreground"}`}
            >
              {count}
            </span>
            {unseenInCat > 0 ? (
              <span
                className={`h-1.5 w-1.5 rounded-full ${cfg.dotClass} shrink-0`}
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function BucketSection({
  label,
  events,
}: {
  label: string;
  events: ChangeEvent[];
}) {
  if (events.length === 0) return null;
  const criticalCount = events.filter((e) => e.severity === "critical").length;
  return (
    <section className="space-y-1.5">
      {/* Bucket header */}
      <div className="flex items-center gap-2.5 px-0.5 pb-1">
        <div className="h-px flex-1 bg-border/40" />
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs font-semibold uppercase tracking-[0.15em] text-muted-foreground/70">
            {label}
          </span>
          <span className="text-xs text-muted-foreground/50">
            {events.length} change{events.length !== 1 ? "s" : ""}
          </span>
          {criticalCount > 0 ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-signal-critical">
              <Circle className="h-1.5 w-1.5 fill-current" />
              {criticalCount} critical
            </span>
          ) : null}
        </div>
        <div className="h-px flex-1 bg-border/40" />
      </div>

      {/* Timeline cards */}
      <div className="space-y-1.5">
        {events.map((e) => (
          <ChangeCard key={e.id} event={e} />
        ))}
      </div>
    </section>
  );
}

function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
      <div className="p-4 rounded-full bg-muted/50">
        <Activity className="h-8 w-8 text-muted-foreground/40" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">
          {filtered ? "No changes in this category" : "All caught up"}
        </p>
        <p className="text-xs text-muted-foreground max-w-xs">
          {filtered
            ? "Try switching to All to see changes across all categories."
            : "No operational changes detected in the current window. Check back after your next round of activity."}
        </p>
      </div>
    </div>
  );
}

// ── Ranking logic hook (exported for reuse) ───────────────────────────────────

export function useChanges() {
  const [data, setData] = useState<ChangesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [marking, setMarking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/delta/changes", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as ChangesResponse);
    } catch (err) {
      console.error("[useChanges] fetch error", err);
      setError("Could not load changes. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  const markSeen = useCallback(async () => {
    setMarking(true);
    try {
      await fetch("/api/delta/seen", { method: "POST" });
      await load();
    } finally {
      setMarking(false);
    }
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, loading, error, marking, refresh: load, markSeen };
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function WhatChangedPage() {
  const { shouldShowChange, mode, isDefault } = useMode();
  const { data, loading, error, marking, refresh, markSeen } = useChanges();
  const [activeFilter, setActiveFilter] = useState<ChangeCategory | null>(null);

  // All changes that pass the mode filter
  const modeFiltered = (data?.changes ?? []).filter((e) =>
    shouldShowChange(e.severity, e.category)
  );
  const unseenCount = modeFiltered.filter((e) => !e.seen).length;

  // Apply mode + category filters to a bucket array
  function filterBuckets(buckets: ChangesResponse["buckets"]) {
    return buckets.map((b) => ({
      ...b,
      changes: b.changes.filter(
        (e) =>
          shouldShowChange(e.severity, e.category) &&
          (activeFilter === null || e.category === activeFilter)
      ),
    }));
  }

  const filteredBuckets = data ? filterBuckets(data.buckets) : [];
  const filteredTotal = filteredBuckets.reduce(
    (s, b) => s + b.changes.length,
    0
  );

  return (
    <div className="p-4 sm:p-6 lg:p-10 max-w-3xl mx-auto space-y-6">
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="basil-display text-2xl font-semibold">
              What Changed
            </h1>
            {!isDefault ? (
              <span
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${mode.bgClass} ${mode.colorClass} ${mode.borderClass}`}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-current" />
                {mode.shortLabel}
              </span>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            {data
              ? `${modeFiltered.length} change${modeFiltered.length !== 1 ? "s" : ""} · ${sinceLabel(data.since)}`
              : "Detecting operational changes…"}
            {!isDefault ? (
              <span className="ml-1 text-muted-foreground/60">
                · filtered by mode
              </span>
            ) : null}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => void refresh()}
            disabled={loading}
            className="p-2 rounded-lg hover:bg-muted transition-colors text-muted-foreground hover:text-foreground disabled:opacity-40"
            aria-label="Refresh"
          >
            <RefreshCw
              className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
            />
          </button>

          {unseenCount > 0 ? (
            <button
              onClick={() => void markSeen()}
              disabled={marking}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors disabled:opacity-50"
            >
              <CheckCheck className="h-3.5 w-3.5" />
              {marking ? "Marking…" : `Mark ${unseenCount} seen`}
            </button>
          ) : null}
        </div>
      </div>

      {/* ── Error ── */}
      {error ? (
        <div className="basil-card p-4 border-signal-critical/20 bg-signal-critical-subtle text-sm text-signal-critical">
          {error}
        </div>
      ) : null}

      {/* ── Loading skeleton ── */}
      {loading && !data ? (
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="basil-card p-4 animate-pulse space-y-2">
              <div className="flex justify-between">
                <div className="h-3 bg-muted rounded w-2/5" />
                <div className="h-3 bg-muted/50 rounded w-12" />
              </div>
              <div className="h-3 bg-muted/60 rounded w-3/4" />
              <div className="flex gap-2 pt-1">
                <div className="h-5 bg-muted/40 rounded w-16" />
                <div className="h-5 bg-muted/40 rounded w-20" />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {/* ── Content ── */}
      {data && !loading ? (
        <div className="space-y-6">
          {/* Category filter bar */}
          {modeFiltered.length > 0 ? (
            <CategoryFilterBar
              changes={modeFiltered}
              active={activeFilter}
              onSelect={setActiveFilter}
            />
          ) : null}

          {/* Timeline buckets */}
          {filteredTotal > 0 ? (
            <div className="space-y-8">
              {filteredBuckets.map((bucket) =>
                bucket.changes.length > 0 ? (
                  <BucketSection
                    key={bucket.label}
                    label={bucket.label}
                    events={bucket.changes}
                  />
                ) : null
              )}
            </div>
          ) : (
            <EmptyState filtered={activeFilter !== null} />
          )}
        </div>
      ) : null}
    </div>
  );
}
