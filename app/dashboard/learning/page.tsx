"use client";

/**
 * "What Basil has learned" — the transparency + control surface for the learning
 * loop. Lists every muted/demoted source and every category prior, each fully
 * reversible. This is the trust layer: nothing the system inferred is hidden, and
 * the user can correct or forget any of it.
 */

import useSWR, { mutate } from "swr";
import { useState } from "react";
import { Lightbulb, BellOff, ArrowDownNarrowWide, RotateCcw, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

interface SourcePreference {
  sourceKey: string;
  sourceLabel?: string;
  state: "muted" | "demoted";
  since: string;
  until?: string;
}
type Disposition = "instant" | "defer" | "delegate" | "noise" | "neutral";
interface CategoryPrior {
  taskClass: string;
  total: number;
  done: number;
  push: number;
  delegate: number;
  delete: number;
  disposition: Disposition;
}

const fetcher = (u: string) => fetch(u).then((r) => (r.ok ? r.json() : { preferences: [], priors: [] }));

const DISPOSITION_META: Record<Disposition, { label: string; chip: string }> = {
  instant:  { label: "You action these fast",  chip: "text-signal-positive" },
  defer:    { label: "You usually push these", chip: "text-signal-warning" },
  delegate: { label: "You usually delegate",   chip: "text-signal-info" },
  noise:    { label: "You usually clear these", chip: "text-signal-critical" },
  neutral:  { label: "Still learning",         chip: "text-muted-foreground" },
};

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function LearningProfilePage() {
  const { data } = useSWR<{ preferences: SourcePreference[]; priors: CategoryPrior[] }>(
    "/api/learning/profile",
    fetcher,
    { revalidateOnFocus: false }
  );
  const [busy, setBusy] = useState<string | null>(null);

  async function act(op: string, target: { sourceKey?: string; taskClass?: string }, key: string) {
    setBusy(key);
    try {
      await fetch("/api/learning/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op, ...target }),
      });
      await Promise.all([mutate("/api/learning/profile"), mutate("/api/today"), mutate("/api/learning/suggestions")]);
    } catch {
      /* ignore */
    } finally {
      setBusy(null);
    }
  }

  const preferences = data?.preferences ?? [];
  const priors = (data?.priors ?? []).filter((p) => p.disposition !== "neutral" || p.total >= 3);

  return (
    <div className="relative mx-auto max-w-3xl px-6 py-8 lg:px-8 space-y-8">
      <header>
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gold/10 text-gold">
            <Lightbulb className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">What Basil has learned</h1>
            <p className="text-sm text-muted-foreground">Everything it inferred from how you work — all of it reversible.</p>
          </div>
        </div>
      </header>

      {/* ── Muted & demoted sources ──────────────────────────────────────── */}
      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">Sources you&apos;ve tuned</h2>
        {preferences.length === 0 ? (
          <div className="rounded-xl border border-border/50 bg-card/40 px-4 py-6 text-center text-sm text-muted-foreground">
            No sources muted or lowered yet. When you keep dismissing one, Basil will offer to quiet it.
          </div>
        ) : (
          <div className="space-y-2">
            {preferences.map((p) => {
              const muted = p.state === "muted";
              const Icon = muted ? BellOff : ArrowDownNarrowWide;
              return (
                <div key={p.sourceKey} className="flex items-center gap-3 rounded-xl border border-border/60 bg-card/60 px-4 py-3">
                  <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", muted ? "bg-signal-critical-subtle text-signal-critical" : "bg-signal-warning-subtle text-signal-warning")}>
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{p.sourceLabel || p.sourceKey}</p>
                    <p className="text-xs text-muted-foreground">
                      {muted ? "Ingestion suspended" : "Lowered priority"}
                      {p.until && ` · until ${new Date(p.until).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`}
                    </p>
                  </div>
                  <button
                    onClick={() => act("unmute", { sourceKey: p.sourceKey }, `unmute:${p.sourceKey}`)}
                    disabled={busy !== null}
                    className="rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground disabled:opacity-50"
                  >
                    {busy === `unmute:${p.sourceKey}` ? "…" : "Restore"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Category priors ──────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">How you handle each kind of task</h2>
        {priors.length === 0 ? (
          <div className="rounded-xl border border-border/50 bg-card/40 px-4 py-6 text-center text-sm text-muted-foreground">
            <Sparkles className="mx-auto mb-2 h-4 w-4 text-gold" />
            Still learning your patterns. Keep using Done / Push / Delegate on the home and they&apos;ll show up here.
          </div>
        ) : (
          <div className="space-y-2">
            {priors.map((p) => {
              const meta = DISPOSITION_META[p.disposition];
              return (
                <div key={p.taskClass} className="flex items-center gap-3 rounded-xl border border-border/60 bg-card/60 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-foreground">{titleCase(p.taskClass)}</p>
                      <span className={cn("text-xs font-medium", meta.chip)}>· {meta.label}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {p.total} {p.total === 1 ? "interaction" : "interactions"} · {p.done} done · {p.push} pushed · {p.delegate} delegated · {p.delete} cleared
                    </p>
                  </div>
                  <button
                    onClick={() => act("reset-category", { taskClass: p.taskClass }, `reset:${p.taskClass}`)}
                    disabled={busy !== null}
                    title="Forget this pattern and relearn"
                    className="flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground disabled:opacity-50"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    {busy === `reset:${p.taskClass}` ? "…" : "Reset"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
