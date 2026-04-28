"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ error, reset }: ErrorPageProps) {
  useEffect(() => {
    // Log to Vercel runtime logs (visible in dashboard, not exposed to client)
    console.error("[error-boundary]", error.digest ?? "", error.message);
  }, [error]);

  return (
    <html lang="en">
      <body className="min-h-screen bg-[oklch(0.18_0.05_250)] flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center space-y-6">
          <div className="flex justify-center">
            <div className="p-4 rounded-full bg-red-500/10 border border-red-500/20">
              <AlertTriangle className="w-10 h-10 text-red-400" />
            </div>
          </div>

          <div className="space-y-2">
            <h1
              className="text-2xl font-semibold text-white"
              style={{ fontFamily: "var(--font-fraunces), Georgia, serif" }}
            >
              Something went wrong
            </h1>
            <p className="text-white/50 text-sm">
              An unexpected error occurred. The team has been notified.
            </p>
            {error.digest && (
              <p className="text-white/25 text-xs font-mono">
                Error ID: {error.digest}
              </p>
            )}
          </div>

          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <button
              onClick={reset}
              className="px-5 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
            >
              Try again
            </button>
            <a
              href="/dashboard"
              className="px-5 py-2.5 rounded-lg border border-white/10 hover:border-white/20 text-white/70 hover:text-white text-sm font-medium transition-colors"
            >
              Back to dashboard
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
