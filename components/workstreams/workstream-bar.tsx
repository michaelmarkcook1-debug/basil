"use client";

/**
 * Today's workstream filter: All, the four workstreams, and Unsorted, each with
 * how many things need you there. The choice is remembered on this device.
 */

import { useEffect, useState } from "react";
import { WORKSTREAMS, isWorkstream, type Workstream } from "@/lib/workstreams/types";

export type WorkstreamFilter = Workstream | "unsorted" | "all";

const KEY = "basil.today.workstream";

/** The remembered filter (per device; falls back to All). */
export function useWorkstreamFilter(): [WorkstreamFilter, (f: WorkstreamFilter) => void] {
  const [f, setF] = useState<WorkstreamFilter>("all");
  useEffect(() => {
    try {
      const v = localStorage.getItem(KEY);
      if (v && (isWorkstream(v) || v === "unsorted")) setF(v);
    } catch { /* storage blocked: All */ }
  }, []);
  const set = (next: WorkstreamFilter) => {
    setF(next);
    try { localStorage.setItem(KEY, next); } catch { /* fine */ }
  };
  return [f, set];
}

export function WorkstreamBar({ value, onChange, totals }: {
  value: WorkstreamFilter;
  onChange: (f: WorkstreamFilter) => void;
  /** Things that need you, per workstream ("unsorted" included). */
  totals?: Partial<Record<Workstream | "unsorted", number>>;
}) {
  const all = Object.values(totals ?? {}).reduce((n, v) => n + (v ?? 0), 0);
  const unsorted = totals?.unsorted ?? 0;
  const tabs: Array<{ id: WorkstreamFilter; label: string; n?: number; fg?: string; bg?: string }> = [
    { id: "all", label: "All work", n: totals ? all : undefined },
    ...WORKSTREAMS.map((w) => ({ id: w.id as WorkstreamFilter, label: w.label, n: totals?.[w.id], fg: w.fg, bg: w.bg })),
    ...(unsorted > 0 || value === "unsorted" ? [{ id: "unsorted" as WorkstreamFilter, label: "Unsorted", n: unsorted }] : []),
  ];
  return (
    <nav aria-label="Workstreams" className="sticky top-0 z-20 -mx-1 flex flex-wrap gap-2 rounded-2xl bg-[var(--w-paper)]/85 px-1 py-2 backdrop-blur">
      {tabs.map((t) => {
        const on = value === t.id;
        return (
          <button
            key={t.id}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(t.id)}
            className="inline-flex min-h-[40px] items-center gap-2 rounded-full border px-3.5 text-[14px] font-medium transition-colors"
            style={on
              ? { background: t.fg ?? "#10213F", borderColor: t.fg ?? "#10213F", color: "#F6F1E7" }
              : { background: t.bg ?? "var(--w-flimsy)", borderColor: "var(--w-rule)", color: t.fg ?? "var(--w-ink)" }}
          >
            {t.label}
            {typeof t.n === "number" && (
              <span className="rounded-full px-1.5 text-[12px] font-semibold tabular-nums" style={{ background: on ? "rgba(246,241,231,.2)" : "rgba(16,33,63,.07)" }} aria-label={`${t.n} need you`}>{t.n}</span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
