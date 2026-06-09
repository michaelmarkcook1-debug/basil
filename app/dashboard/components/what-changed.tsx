"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Activity,
  AlertTriangle,
  Users,
  Zap,
  Shield,
  TrendingUp,
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

const SEVERITY_BAR: Record<ChangeSeverity, string> = {
  critical: "bg-red-500",
  high:     "bg-amber-500",
  medium:   "bg-blue-500",
  low:      "bg-muted-foreground/25",
};

const SEVERITY_BAR_WIDTH: Record<ChangeSeverity, string> = {
  critical: "w-[3px]",
  high:     "w-[2px]",
  medium:   "w-[2px]",
  low:      "w-[2px]",
};

const CATEGORY_ICON: Record<ChangeCategory, React.ReactNode> = {
  urgency:      <AlertTriangle className="h-2.5 w-2.5" />,
  relationship: <Users className="h-2.5 w-2.5" />,
  operational:  <Zap className="h-2.5 w-2.5" />,
  confidence:   <Shield className="h-2.5 w-2.5" />,
  momentum:     <TrendingUp className="h-2.5 w-2.5" />,
};

const MAX_WIDGET_ROWS = 4;

// ── Sub-components ────────────────────────────────────────────────────────────

function CompactRow({ event }: { event: ChangeEvent }) {
  const cfg = CATEGORY_CONFIG[event.category];
  const inner = (
    <div
      className={[
        "relative pl-3.5 pr-2 py-2.5 hover:bg-muted/40 transition-colors rounded group",
        event.severity === "critical"
          ? "bg-red-500/[0.03] dark:bg-red-950/15"
          : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div
        className={`absolute left-0 top-1 bottom-1 rounded-full ${SEVERITY_BAR[event.severity]} ${SEVERITY_BAR_WIDTH[event.severity]}`}
        aria-hidden
      />
      {/* Unseen dot */}
      {!event.seen ? (
        <span
          className="absolute top-2 right-2 h-1 w-1 rounded-full bg-primary"
          aria-hidden
        />
      ) : null}
      <div className="flex items-start justify-between gap-2 min-w-0">
        <div className="min-w-0 space-y-0.5">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs font-medium text-foreground truncate leading-snug">
              {event.title}
            </span>
            <span
              className={`inline-flex items-center gap-0.5 text-xs font-medium ${cfg.colorClass}`}
            >
              {CATEGORY_ICON[event.category]}
              {cfg.label}
            </span>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed line-clamp-1">
            {event.context}
          </p>
        </div>
        {event.entityHref ? (
          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/40 group-hover:text-primary transition-colors mt-0.5" />
        ) : null}
      </div>
    </div>
  );

  if (event.entityHref) {
    return <Link href={event.entityHref}>{inner}</Link>;
  }
  return inner;
}

function SkeletonRow() {
  return (
    <div className="pl-3.5 py-2.5 animate-pulse space-y-1.5">
      <div className="h-2.5 bg-muted rounded w-1/2" />
      <div className="h-2 bg-muted/60 rounded w-3/4" />
    </div>
  );
}

function CriticalBanner({ count }: { count: number }) {
  return (
    <Link
      href="/dashboard/delta"
      className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-red-500/10 dark:bg-red-950/25 text-red-600 dark:text-red-400 text-xs font-medium hover:bg-red-500/15 transition-colors"
    >
      <Circle className="h-2 w-2 fill-current shrink-0" />
      {count} critical change{count !== 1 ? "s" : ""} need attention
      <ArrowRight className="h-3 w-3 ml-auto" />
    </Link>
  );
}

// ── Widget ────────────────────────────────────────────────────────────────────

export function WhatChangedWidget() {
  const [data, setData] = useState<ChangesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const { shouldShowChange, mode, isDefault } = useMode();

  useEffect(() => {
    fetch("/api/delta/changes", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: ChangesResponse | null) => {
        if (d) setData(d);
      })
      .catch((err: unknown) => {
        console.error("[what-changed-widget] fetch error", err);
      })
      .finally(() => setLoading(false));
  }, []);

  // Filter changes through active mode
  const filteredChanges = (data?.changes ?? []).filter((e) =>
    shouldShowChange(e.severity, e.category)
  );

  const criticalChanges = filteredChanges.filter(
    (e) => e.severity === "critical"
  );
  const topChanges = filteredChanges.slice(0, MAX_WIDGET_ROWS);
  const hasMore = filteredChanges.length > MAX_WIDGET_ROWS;
  const unseenCount = data?.unseenCount ?? 0;

  return (
    <div className="basil-card p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <span className="basil-eyebrow text-xs">What Changed</span>
          {!isDefault ? (
            <span className={`text-xs font-medium ${mode.colorClass}`}>
              {mode.shortLabel}
            </span>
          ) : null}
          {unseenCount > 0 ? (
            <span className="inline-flex items-center justify-center h-4 min-w-4 px-1 rounded-full bg-primary text-primary-foreground text-xs font-semibold">
              {unseenCount}
            </span>
          ) : null}
        </div>
        <Link
          href="/dashboard/delta"
          className="text-xs text-muted-foreground hover:text-primary transition-colors flex items-center gap-0.5"
        >
          All changes
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      {/* Critical banner (if any) */}
      {criticalChanges.length > 0 ? (
        <CriticalBanner count={criticalChanges.length} />
      ) : null}

      {/* Rows */}
      <div className="-mx-1 px-1">
        {loading ? (
          <div className="space-y-0.5">
            {[1, 2, 3].map((i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        ) : topChanges.length > 0 ? (
          <div className="space-y-0.5">
            {topChanges.map((e) => (
              <CompactRow key={e.id} event={e} />
            ))}
          </div>
        ) : (
          <div className="py-4 text-center">
            <p className="text-xs text-muted-foreground">
              All caught up — no recent changes
            </p>
          </div>
        )}
      </div>

      {/* "N more" footer */}
      {hasMore ? (
        <Link
          href="/dashboard/delta"
          className="block text-center text-xs text-muted-foreground hover:text-primary transition-colors py-1 border-t border-border/50"
        >
          {filteredChanges.length - MAX_WIDGET_ROWS} more change
          {filteredChanges.length - MAX_WIDGET_ROWS !== 1 ? "s" : ""}
        </Link>
      ) : null}
    </div>
  );
}
