"use client";

/**
 * WeeklyBriefCard — the "Weekly brief" surface on Today.
 *
 * Deliberately mirrors the "Full briefing" collapsible it sits beside, but
 * reads the WEEKLY digest (/api/generate/digest) rather than the daily
 * briefing, so the two read as one family rather than two inventions.
 *
 * Generation is EXPLICIT, never automatic. The digest is a long-context call
 * across the whole week on the flagship tier, so expanding the card must never
 * silently spend that: GET returns the cached brief for this week (or null),
 * and a fresh one is only produced when the user asks. That also keeps the card
 * instant on every open once a brief exists.
 */

import { useState } from "react";
import useSWR from "swr";
import { CalendarRange, ChevronDown, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Digest } from "@/lib/types/briefing";

/**
 * The prose sections of a Digest, in reading order.
 *
 * Listed explicitly rather than derived from `keyof Digest`: a Digest also
 * carries metadata (generatedAt, weekStart/weekEnd, and the dataSources counts
 * object) which isn't renderable copy. Indexing `digest[s.key]` below still
 * type-checks each key against Digest, so renaming a section at the source
 * breaks the build here instead of silently rendering nothing.
 */
type DigestSectionKey =
  | "majorMeetings"
  | "whatChanged"
  | "decisionsLog"
  | "blockers"
  | "relationshipSignals"
  | "nextWeekNeeds";

const DIGEST_SECTIONS: Array<{ key: DigestSectionKey; label: string }> = [
  { key: "majorMeetings",       label: "Major meetings" },
  { key: "whatChanged",         label: "What changed" },
  { key: "decisionsLog",        label: "Decisions log" },
  { key: "blockers",            label: "Blockers" },
  { key: "relationshipSignals", label: "Relationship signals" },
  { key: "nextWeekNeeds",       label: "Next week needs" },
];

const swrFetch = (url: string) => fetch(url, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null));

function generatedLabel(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

export function WeeklyBriefCard() {
  const [open, setOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // GET is cache-only: it returns this week's brief, or null if none is cached.
  // It never triggers generation, so mounting Today costs nothing.
  const { data: digest, mutate } = useSWR<Digest | null>(
    "/api/generate/digest",
    swrFetch,
    { revalidateOnFocus: false, dedupingInterval: 5 * 60_000 }
  );

  const hasContent = !!digest && DIGEST_SECTIONS.some((s) => digest[s.key]);
  // Prefer the real week window the server computed in the user's timezone
  // ("28 Apr – 4 May"); fall back to when it was built.
  const range = digest?.weekStart && digest?.weekEnd ? `${digest.weekStart} – ${digest.weekEnd}` : null;
  const stamp = range ?? generatedLabel(digest?.generatedAt);

  async function generate() {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/generate/digest", { method: "POST" });
      if (!res.ok) {
        setError(
          res.status === 429
            ? "AI budget reached — try again later."
            : `Couldn't build the brief (HTTP ${res.status}). Try again.`
        );
        return;
      }
      const data = (await res.json()) as Digest;
      // Seed SWR with the fresh brief rather than re-fetching it.
      await mutate(data, { revalidate: false });
    } catch {
      setError("Network error building the brief. Try again.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <section>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-xl border border-border/60 bg-card/40 px-4 py-3 text-left transition-all hover:bg-card/70"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gold/10 text-gold">
          <CalendarRange className="h-3.5 w-3.5" />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">Weekly brief</p>
          <p className="text-xs text-muted-foreground">
            {hasContent
              ? `Your week in review${stamp ? ` · ${stamp}` : ""}`
              : "Your week in review — meetings, decisions, blockers, what's next"}
          </p>
        </div>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="mt-2 rounded-xl border border-border/40 bg-card/20 px-4 py-4">
          {error && (
            <p className="mb-3 rounded-md border border-signal-critical-border bg-signal-critical-subtle px-2.5 py-1.5 text-xs text-signal-critical">
              {error}
            </p>
          )}

          {hasContent ? (
            <>
              <div className="grid gap-4 md:grid-cols-2">
                {DIGEST_SECTIONS.filter((s) => digest?.[s.key]).map((s) => (
                  <div key={s.key}>
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gold/80">{s.label}</p>
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/85">{digest?.[s.key]}</p>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => void generate()}
                disabled={generating}
                className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-gold hover:border-gold/40 disabled:opacity-50"
              >
                {generating
                  ? <><Loader2 className="h-3 w-3 animate-spin" /> Rebuilding…</>
                  : <><RefreshCw className="h-3 w-3" /> Rebuild</>}
              </button>
            </>
          ) : (
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm text-muted-foreground">
                No brief for this week yet. Basil will read back over your meetings, decisions,
                commitments and signals from the week and write it up.
              </p>
              <button
                type="button"
                onClick={() => void generate()}
                disabled={generating}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gold/30 bg-gold/[0.08] px-3 py-2 text-sm font-medium text-gold transition-colors hover:bg-gold/[0.14] disabled:opacity-60"
              >
                {generating
                  ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Building your week…</>
                  : <><Sparkles className="h-3.5 w-3.5" /> Build weekly brief</>}
              </button>
              {generating && (
                <p className="text-xs text-muted-foreground/70">
                  This reads your whole week, so it can take a minute.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
