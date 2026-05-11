"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Info } from "lucide-react";
import type { ReadinessReport } from "@/lib/readiness";

export function ReadinessCard() {
  const [report, setReport] = useState<ReadinessReport | null>(null);

  useEffect(() => {
    fetch("/api/readiness")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) setReport(data as ReadinessReport); })
      .catch((e: unknown) => {
        console.error("[readiness-card] fetch failed:", e instanceof Error ? e.message : String(e));
      });
  }, []);

  // Don't render until data arrives
  if (!report) return null;

  // All good — nothing to show
  if (report.score === 100 || report.blockers.length === 0) return null;

  const topChecks = report.checks
    .filter((c) => !c.ok)
    .sort((a, b) => {
      const order = { blocker: 0, warning: 1, info: 2 };
      return (order[a.severity] ?? 2) - (order[b.severity] ?? 2);
    })
    .slice(0, 3);

  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-amber-800">Basil needs attention before it can work fully</p>
        <span className="text-xs font-medium text-amber-700">{report.score}% ready</span>
      </div>
      <div className="space-y-2">
        {topChecks.map((check) => (
          <div key={check.id} className="flex items-start gap-2">
            {check.severity === "blocker" ? (
              <AlertTriangle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
            ) : (
              <Info className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
            )}
            <div className="min-w-0">
              <p className="text-xs font-medium text-foreground">{check.label}</p>
              <p className="text-xs text-muted-foreground">{check.action}</p>
            </div>
          </div>
        ))}
      </div>
      <a
        href="/dashboard/settings"
        className="inline-flex items-center gap-1 text-xs font-medium text-[oklch(0.58_0.15_85)] hover:underline"
      >
        Fix in Settings →
      </a>
    </div>
  );
}
