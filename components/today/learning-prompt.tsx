"use client";

/**
 * LearningPrompt — surfaces Basil's "this source looks like noise" suggestion.
 *
 * Shows one suggestion at a time (the strongest). The user decides: Mute (suspend
 * ingestion), Mute 30 days, Lower priority (keep but demote — the safe middle), or
 * Not now (dismissed for a cooldown). Nothing is ever suppressed without this
 * confirm. After a decision it revalidates the feed.
 */

import useSWR, { mutate } from "swr";
import { useState } from "react";
import { BellOff, Sparkles, X, ArrowDownNarrowWide, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

interface MuteSuggestion {
  sourceKey: string;
  sourceLabel: string;
  deletes: number;
  total: number;
  windowDays: number;
}

const fetcher = (u: string) =>
  fetch(u).then((r) => (r.ok ? r.json() : { suggestions: [] }));

export function LearningPrompt() {
  const { data } = useSWR<{ suggestions: MuteSuggestion[] }>(
    "/api/learning/suggestions",
    fetcher,
    { revalidateOnFocus: false, dedupingInterval: 60_000 }
  );
  const [busy, setBusy] = useState<string | null>(null);

  const s = data?.suggestions?.[0];
  if (!s) return null;

  async function decide(decision: string) {
    if (!s) return;
    setBusy(decision);
    try {
      await fetch("/api/learning/suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceKey: s.sourceKey, decision, sourceLabel: s.sourceLabel }),
      });
      await Promise.all([mutate("/api/learning/suggestions"), mutate("/api/today")]);
    } catch {
      /* ignore */
    } finally {
      setBusy(null);
    }
  }

  const Action = ({ decision, label, icon: Icon, primary }: { decision: string; label: string; icon: typeof BellOff; primary?: boolean }) => (
    <button
      type="button"
      onClick={() => decide(decision)}
      disabled={busy !== null}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50",
        primary
          // Hover dims the SAME fill rather than swapping to the tint. Swapping put
          // dark-navy text on a 12% gold wash — 1.22:1, invisible — because the
          // text colour is chosen for the solid accent, not for the tint.
          ? "bg-[var(--w-carbon)] text-[color:var(--w-on-accent)] hover:opacity-90"
          : "border border-border/60 text-muted-foreground hover:border-border hover:text-foreground"
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {busy === decision ? "…" : label}
    </button>
  );

  return (
    <section className="rounded-2xl border border-signal-info-border bg-signal-info-subtle p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-signal-info/15 text-signal-info">
          <Sparkles className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">Basil noticed a pattern</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            You&apos;ve dismissed <span className="font-medium text-foreground">{s.deletes}</span> of the last{" "}
            {s.total} items from <span className="font-medium text-foreground">{s.sourceLabel}</span> and opened none in the past {s.windowDays} days. Want Basil to stop surfacing it?
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Action decision="mute" label="Mute it" icon={BellOff} primary />
            <Action decision="demote" label="Lower priority" icon={ArrowDownNarrowWide} />
            <Action decision="mute30" label="Mute 30 days" icon={Clock} />
            <Action decision="dismiss" label="Not now" icon={X} />
          </div>
        </div>
      </div>
    </section>
  );
}
