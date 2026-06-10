"use client";

/**
 * DataState — unified empty/loading/error UI for Basil dashboard cards.
 *
 * Distinguishes "no data yet" (empty) from "failed to load" (error), and
 * shows auth/permission-specific guidance when the error kind is known.
 *
 * Usage:
 *   <DataState loading={loading} error={error} empty={items.length === 0}>
 *     <ItemList items={items} />
 *   </DataState>
 */

import {
  AlertTriangle,
  Lock,
  RefreshCw,
  ServerCrash,
  WifiOff,
  LogIn,
  SearchX,
  Clock,
  Inbox,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { BasilFetchError, type FetchErrorKind } from "@/lib/basil-fetch";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface DataStateProps {
  /** Show a skeleton / spinner instead of content. */
  loading?: boolean;
  /** Error from basilFetch or any Error. Null/undefined = no error. */
  error?: BasilFetchError | Error | null;
  /**
   * Show the empty-state UI instead of children.
   * Ignored when loading=true or error is set.
   */
  empty?: boolean;
  /** Title shown in the empty state. */
  emptyTitle?: string;
  /** Subtitle shown in the empty state. */
  emptyDescription?: string;
  /** Show a subtle "stale data" banner above children without hiding them. */
  stale?: boolean;
  /** Callback wired to the "Try again" button on retryable error states. */
  onRetry?: () => void;
  /** Number of skeleton rows shown when loading. Default: 3. */
  skeletonRows?: number;
  /**
   * When true the component fills its container with flex-column centering
   * (good for full-page states). When false (default) it's inline block-level.
   */
  fill?: boolean;
  className?: string;
  children?: React.ReactNode;
}

// ── Error content map ──────────────────────────────────────────────────────────

interface ErrorConfig {
  Icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  retryable: boolean;
  authAction?: boolean; // show a "Sign in" link
}

const ERROR_CONFIG: Record<FetchErrorKind, ErrorConfig> = {
  auth_error: {
    Icon: LogIn,
    title: "Session expired",
    description: "Your session has ended. Sign in again to continue.",
    retryable: false,
    authAction: true,
  },
  permission_missing: {
    Icon: Lock,
    title: "Permission required",
    description:
      "You don't have access to this data. Check that the connected account has the right permissions, or reconnect the integration in Settings.",
    retryable: false,
  },
  not_found: {
    Icon: SearchX,
    title: "Not found",
    description:
      "This data source couldn't be found. This is usually a configuration issue — check your API routes or contact support.",
    retryable: false,
  },
  timeout: {
    Icon: Clock,
    title: "Request timed out",
    description: "The server took too long to respond. This is usually temporary.",
    retryable: true,
  },
  server_error: {
    Icon: ServerCrash,
    title: "Server error",
    description: "Something went wrong on the server. This is usually temporary.",
    retryable: true,
  },
  network_error: {
    Icon: WifiOff,
    title: "Can't reach server",
    description: "Check your internet connection and try again.",
    retryable: true,
  },
};

// ── Sub-components ─────────────────────────────────────────────────────────────

function SkeletonRows({ rows }: { rows: number }) {
  return (
    <div className="space-y-2.5 py-1 animate-pulse">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-2.5">
          <div className="h-3.5 w-3.5 rounded-full bg-muted" />
          <div
            className="h-3 rounded bg-muted"
            style={{ width: `${55 + (i * 17) % 35}%` }}
          />
        </div>
      ))}
    </div>
  );
}

function EmptyState({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 px-4 text-center">
      <Inbox className="h-8 w-8 text-muted-foreground/40" />
      <p className="text-sm font-medium text-muted-foreground">{title}</p>
      {description && (
        <p className="text-xs text-muted-foreground/70 max-w-xs leading-relaxed">
          {description}
        </p>
      )}
    </div>
  );
}

function ErrorState({
  kind,
  message,
  onRetry,
}: {
  kind: FetchErrorKind;
  message?: string;
  onRetry?: () => void;
}) {
  const cfg = ERROR_CONFIG[kind];
  const { Icon } = cfg;

  return (
    <div className="flex flex-col items-center justify-center gap-3 py-10 px-4 text-center">
      <div className="rounded-full bg-muted p-2.5">
        <Icon className="h-5 w-5 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-foreground">{cfg.title}</p>
        <p className="text-xs text-muted-foreground max-w-xs leading-relaxed">
          {message ?? cfg.description}
        </p>
      </div>
      <div className="flex items-center gap-2 mt-1">
        {cfg.authAction && (
          <Button asChild size="sm" variant="outline" className="h-7 text-xs gap-1.5">
            <a href="/login">
              <LogIn className="h-3.5 w-3.5" />
              Sign in
            </a>
          </Button>
        )}
        {cfg.retryable && onRetry && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1.5"
            onClick={onRetry}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}

function StaleBanner() {
  return (
    <div className="flex items-center gap-1.5 rounded-md bg-signal-warning-subtle border border-signal-warning-border px-3 py-1.5 text-xs text-signal-warning mb-3">
      <AlertTriangle className="h-3 w-3 shrink-0" />
      Showing cached data — live refresh failed
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function DataState({
  loading = false,
  error,
  empty = false,
  emptyTitle = "Nothing here yet",
  emptyDescription,
  stale = false,
  onRetry,
  skeletonRows = 3,
  fill = false,
  className = "",
  children,
}: DataStateProps) {
  const wrapClass = fill
    ? `flex flex-col items-center justify-center min-h-[200px] ${className}`
    : className;

  // Loading
  if (loading && !error) {
    return (
      <div className={wrapClass}>
        <SkeletonRows rows={skeletonRows} />
      </div>
    );
  }

  // Error
  if (error) {
    const kind =
      error instanceof BasilFetchError ? error.kind : "server_error";
    const message =
      error instanceof BasilFetchError
        ? error.serverMessage ?? error.message
        : error.message;

    return (
      <div className={wrapClass}>
        <ErrorState kind={kind} message={message} onRetry={onRetry} />
      </div>
    );
  }

  // Empty
  if (empty) {
    return (
      <div className={wrapClass}>
        <EmptyState title={emptyTitle} description={emptyDescription} />
      </div>
    );
  }

  // Success (possibly stale)
  return (
    <>
      {stale && <StaleBanner />}
      {children}
    </>
  );
}

// ── Inline error badge (for tiles / compact contexts) ─────────────────────────

/**
 * DataErrorBadge — tiny inline indicator for tiles that can't show a full
 * error state (e.g. PulseStrip tiles). Shows a red warning icon with tooltip.
 */
export function DataErrorBadge({
  error,
  className = "",
}: {
  error: BasilFetchError | Error | null | undefined;
  className?: string;
}) {
  if (!error) return null;
  const kind =
    error instanceof BasilFetchError ? error.kind : "server_error";
  const cfg = ERROR_CONFIG[kind];

  return (
    <span
      className={`inline-flex items-center gap-1 text-xs font-medium text-signal-critical ${className}`}
      title={cfg.description}
    >
      <AlertTriangle className="h-3 w-3" />
      {kind === "auth_error" ? "Auth" : kind === "network_error" ? "Offline" : "Error"}
    </span>
  );
}
