"use client";

/**
 * Your work: the live projects with the most going on, each with a 14-day
 * strip of its recent signals (messages, issues, decisions Basil tied to it),
 * its status and the next best action. Counted from the project radar — a
 * project's newest signals only, so the strip is "recent activity", not a full
 * history.
 */

import Link from "next/link";
import { useMemo } from "react";
import type { CanonicalProject } from "@/lib/projects/types";
import { dailySignals } from "@/lib/today/visual-data";

export type ProjectLite = Pick<CanonicalProject, "id" | "name" | "status" | "priority" | "nextBestAction" | "lastActiveAt" | "signals" | "blockerCount">;

const STATUS: Record<CanonicalProject["status"], { label: string; color: string }> = {
  moving: { label: "Moving", color: "#1F8A70" },
  "needs-review": { label: "Needs review", color: "#2F5FA8" },
  stalled: { label: "Stalled", color: "#2F5FA8" },
  blocked: { label: "Blocked", color: "#D9661F" },
  quiet: { label: "Quiet", color: "#8A8F99" },
};
const RANK: Record<CanonicalProject["status"], number> = { blocked: 0, moving: 1, "needs-review": 2, stalled: 3, quiet: 4 };

export function WorkPanel({
  projects, failed, now, delay = 0,
}: { projects?: ProjectLite[]; failed: boolean; now: Date; delay?: number }) {
  const rows = useMemo(() => (projects ?? [])
    .filter((p) => p.status !== "quiet")
    .sort((a, b) => RANK[a.status] - RANK[b.status] || b.lastActiveAt.localeCompare(a.lastActiveAt))
    .slice(0, 3)
    .map((p) => {
      const series = dailySignals(p.signals ?? [], now);
      const max = Math.max(3, ...series);
      return { p, series, max };
    }), [projects, now]);

  return (
    <section aria-labelledby="work-h" className="basil-rise flex flex-col gap-1.5 rounded-[20px] border border-[var(--w-rule)] bg-[var(--w-flimsy)] p-[22px]" style={{ animationDelay: `${delay}ms` }}>
      <div className="flex items-baseline justify-between gap-2.5 pb-1.5">
        <h2 id="work-h" className="basil-serif text-[26px] text-[#10213F]">Your work</h2>
        <span className="text-[12px] text-[color:var(--w-ink-soft)]">recent signals · 14 days</span>
      </div>
      {failed ? (
        <p className="text-[14px] text-[color:var(--w-stamp)]">The project radar could not be read just now.</p>
      ) : !projects ? (
        <p className="text-[14px] text-[color:var(--w-ink-soft)]">Reading your projects…</p>
      ) : rows.length === 0 ? (
        <p className="text-[14px] text-[color:var(--w-ink-soft)]">No active projects found yet.</p>
      ) : rows.map(({ p, series, max }, pi) => {
        const st = STATUS[p.status];
        return (
          <Link key={p.id} href="/dashboard/projects" className="basil-lift -mx-2 flex flex-col gap-2.5 rounded-[14px] border border-transparent p-3.5 text-[color:var(--w-ink)] no-underline">
            <span className="flex items-center gap-2.5">
              <span className="min-w-0 truncate text-[16px] font-semibold">{p.name}</span>
              <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-[12px] font-semibold">
                <span className="h-2 w-2 rounded-full" style={{ background: st.color }} />{st.label}
              </span>
            </span>
            <span aria-hidden className="flex h-10 items-end gap-[3px]">
              {series.map((v, i) => (
                <span
                  key={i}
                  className="basil-col flex-1 rounded-t-[3px] rounded-b-[1px]"
                  style={{
                    height: Math.max(3, Math.round((v / max) * 40)),
                    background: v === 0 ? "var(--w-tray)" : st.color,
                    opacity: i === series.length - 1 ? 1 : 0.55 + (i / series.length) * 0.35,
                    animationDelay: `${delay + 200 + pi * 120 + i * 25}ms`,
                  }}
                />
              ))}
            </span>
            {p.nextBestAction && <span className="text-[13px] leading-snug text-[color:var(--w-ink-soft)]">{p.nextBestAction}</span>}
          </Link>
        );
      })}
    </section>
  );
}
