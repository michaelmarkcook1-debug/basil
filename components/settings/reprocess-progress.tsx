"use client";

/**
 * Progress of "Re-process recent events" (lib/events/reprocess-status): it runs
 * in the background, so this polls while it is going and then says what it
 * found — or that it stopped part-way and pressing again carries on.
 */

import { useEffect, useState } from "react";

interface Status {
  startedAt: string; updatedAt: string; breakdown: string; total: number; checked: number; unchanged: number; failed: number;
  finishedAt?: string; newActions?: number; newDecisions?: number; stoppedEarly?: boolean; by: "cron" | "button";
}

const time = (iso: string) => new Date(iso).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });
const STALE_MS = 6 * 60_000;

export function ReprocessProgress({ kick }: { kick: number }) {
  const [s, setS] = useState<Status | null>(null);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const r = await fetch("/api/events/reprocess/status", { cache: "no-store" });
        const d = r.ok ? ((await r.json()) as { status: Status | null }) : null;
        if (!live) return;
        setS(d?.status ?? null);
        const running = d?.status && !d.status.finishedAt && Date.now() - Date.parse(d.status.updatedAt) < STALE_MS;
        if (running) timer = setTimeout(poll, 4_000);
      } catch {
        if (live) timer = setTimeout(poll, 10_000);
      }
    };
    void poll();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [kick]);

  if (!s) return null;
  const stale = !s.finishedAt && Date.now() - Date.parse(s.updatedAt) >= STALE_MS;
  const pct = s.total ? Math.min(100, Math.round((s.checked / s.total) * 100)) : 0;

  if (!s.finishedAt && !stale) {
    return (
      <div className="space-y-1.5 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground" role="status" aria-live="polite">
        <p>Analysing {s.checked} of {s.total} ({s.breakdown})…{s.unchanged ? ` ${s.unchanged} unchanged since last time, skipped without an AI call.` : ""}</p>
        <div className="h-1.5 overflow-hidden rounded-full bg-background"><div className="h-full rounded-full bg-[var(--w-carbon)] transition-[width]" style={{ width: `${pct}%` }} /></div>
      </div>
    );
  }
  const found = [
    s.newActions !== undefined && `${s.newActions} new action${s.newActions === 1 ? "" : "s"}`,
    s.newDecisions !== undefined && `${s.newDecisions} new decision${s.newDecisions === 1 ? "" : "s"}`,
  ].filter(Boolean).join(", ");
  return (
    <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground" role="status">
      {stale || s.stoppedEarly
        ? `Stopped at ${s.checked} of ${s.total} (${stale ? "it was cut off" : "its 5-minute limit"}). What it finished stays done — press again to carry on.`
        : `Finished ${time(s.finishedAt!)}${s.by === "cron" ? " (the daily run)" : ""}: checked ${s.checked} of ${s.total}.`}
      {s.unchanged ? ` ${s.unchanged} were unchanged since last time and skipped without an AI call.` : ""}
      {found ? ` Found ${found}.` : ""}
      {s.failed ? ` ${s.failed} could not be read.` : ""}
    </p>
  );
}
