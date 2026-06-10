"use client";

/**
 * CachedDataBadge — small corner indicator for cards showing cached or
 * stale data.  Drop it inside any card's header to signal to the user
 * whether what they're seeing is live or from a previous fetch.
 *
 * Usage:
 *   <CachedDataBadge fetchedAt={fetchedAt} />
 *   <CachedDataBadge fetchedAt={null} error="Network error" />
 *   <CachedDataBadge live />
 */

import { AlertTriangle, Clock, RefreshCw, WifiOff } from "lucide-react";

interface Props {
  /** ISO timestamp of when the data was last successfully fetched. */
  fetchedAt?: string | number | null;
  /** If true, shows a "Live" indicator instead of a timestamp. */
  live?: boolean;
  /** Error message — shows a red "Failed to refresh" indicator. */
  error?: string | null;
  /** Threshold in minutes before "cached" turns amber. Default: 5. */
  staleMinutes?: number;
  /** Additional className. */
  className?: string;
}

function relAgo(ts: string | number): string {
  const ms =
    typeof ts === "number" ? Date.now() - ts : Date.now() - new Date(ts).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export function CachedDataBadge({
  fetchedAt,
  live = false,
  error,
  staleMinutes = 5,
  className = "",
}: Props) {
  if (error) {
    return (
      <span
        className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium bg-signal-critical-subtle text-signal-critical border border-signal-critical-border ${className}`}
        title={error}
      >
        <WifiOff className="h-2.5 w-2.5" />
        Failed to refresh
      </span>
    );
  }

  if (live) {
    return (
      <span
        className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium bg-signal-positive-subtle text-signal-positive border border-signal-positive-border ${className}`}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-signal-positive animate-pulse" />
        Live
      </span>
    );
  }

  if (!fetchedAt) {
    return (
      <span
        className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium bg-zinc-50 text-zinc-400 border border-zinc-200 ${className}`}
      >
        <Clock className="h-2.5 w-2.5" />
        Cached
      </span>
    );
  }

   
  const now = Date.now();
  const msAgo = typeof fetchedAt === "number" ? now - fetchedAt : now - new Date(fetchedAt).getTime();
  const isStale = msAgo > staleMinutes * 60_000;

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium ${
        isStale
          ? "bg-signal-warning-subtle text-signal-warning border border-signal-warning-border"
          : "bg-zinc-50  text-zinc-400  border border-zinc-200"
      } ${className}`}
      title={`Data fetched ${relAgo(fetchedAt)}`}
    >
      {isStale
        ? <AlertTriangle className="h-2.5 w-2.5" />
        : <RefreshCw className="h-2.5 w-2.5" />}
      {relAgo(fetchedAt)}
    </span>
  );
}
