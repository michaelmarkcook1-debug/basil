"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

/**
 * Segment-level error boundary. Renders INSIDE the root layout's <html>/<body>,
 * so it must NOT emit its own document elements (the previous version did,
 * producing invalid nested <html> during crashes). Styled to the midnight
 * identity; gold action keeps the brand even on the failure path.
 */
export default function ErrorBoundary({ error, reset }: ErrorPageProps) {
  useEffect(() => {
    // Log to Vercel runtime logs (visible in dashboard, not exposed to client)
    console.error("[error-boundary]", error.digest ?? "", error.message);
  }, [error]);

  return (
    <div className="min-h-screen bg-[#07111F] flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center space-y-6">
        <div className="flex justify-center">
          <div className="p-4 rounded-full bg-signal-critical-subtle border border-signal-critical-border">
            <AlertTriangle className="w-10 h-10 text-signal-critical" />
          </div>
        </div>

        <div className="space-y-2">
          <h1
            className="text-2xl font-semibold text-[#F3EFE7]"
            style={{ fontFamily: "var(--font-fraunces), Georgia, serif" }}
          >
            Something went wrong
          </h1>
          <p className="text-[#F3EFE7]/50 text-sm">
            An unexpected error occurred. The team has been notified.
          </p>
          {error.digest && (
            <p className="text-[#F3EFE7]/25 text-xs font-mono">
              Error ID: {error.digest}
            </p>
          )}
        </div>

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <button
            onClick={reset}
            className="px-5 py-2.5 rounded-lg bg-gold hover:bg-gold-muted text-[#07111F] text-sm font-semibold transition-colors"
          >
            Try again
          </button>
          <a
            href="/dashboard"
            className="px-5 py-2.5 rounded-lg border border-[#F3EFE7]/10 hover:border-[#F3EFE7]/20 text-[#F3EFE7]/70 hover:text-[#F3EFE7] text-sm font-medium transition-colors"
          >
            Back to dashboard
          </a>
        </div>
      </div>
    </div>
  );
}
