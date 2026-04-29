"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Brain,
  Search,
  Plus,
  ArrowRight,
  Loader2,
  CheckCircle2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { Memory, MemoryKind } from "@/lib/memory/types";

// ── Types ────────────────────────────────────────────────────────────────────

interface Counts {
  fact: number;
  preference: number;
  person: number;
  context: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const KIND_LABELS: Record<MemoryKind, string> = {
  preference: "Prefs",
  fact: "Facts",
  person: "People",
  context: "Context",
};

// ── Helper ───────────────────────────────────────────────────────────────────

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function buildCounts(memories: Memory[]): Counts {
  const c: Counts = { fact: 0, preference: 0, person: 0, context: 0 };
  for (const m of memories) c[m.kind]++;
  return c;
}

// ── Main component ────────────────────────────────────────────────────────────

export function MemoryPanel() {
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [recallQuery, setRecallQuery] = useState("");
  const [recallResults, setRecallResults] = useState<Memory[] | null>(null);
  const [ingestText, setIngestText] = useState("");
  const [ingestLoading, setIngestLoading] = useState(false);
  const [ingestSuccess, setIngestSuccess] = useState(false);
  const [recallLoading, setRecallLoading] = useState(false);
  const recallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Load memories ──────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/memory", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setMemories(data.memories ?? []);
    } catch {
      // leave previous state; don't wipe it on transient error
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // ── Ingest ─────────────────────────────────────────────────────────────────

  async function handleIngest(e: React.FormEvent) {
    e.preventDefault();
    const text = ingestText.trim();
    if (!text || ingestLoading) return;
    setIngestLoading(true);
    try {
      const res = await fetch("/api/memory/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (res.ok) {
        setIngestText("");
        setIngestSuccess(true);
        await load();
        setTimeout(() => setIngestSuccess(false), 3000);
      }
    } catch {
      // fail silently in the dashboard panel
    } finally {
      setIngestLoading(false);
    }
  }

  // ── Recall (debounced) ─────────────────────────────────────────────────────

  function handleRecallChange(value: string) {
    setRecallQuery(value);
    if (recallTimerRef.current) clearTimeout(recallTimerRef.current);
    if (!value.trim()) { setRecallResults(null); return; }
    recallTimerRef.current = setTimeout(() => runRecall(value.trim()), 350);
  }

  function runRecall(query: string) {
    if (!memories) return;
    const q = query.toLowerCase();
    const matched = memories.filter((m) => {
      if (m.content.toLowerCase().includes(q)) return true;
      if (m.entity?.toLowerCase().includes(q)) return true;
      // word overlap
      const qWords = new Set(q.split(/\s+/).filter((w) => w.length > 2));
      const mWords = m.content.toLowerCase().split(/\s+/);
      return mWords.some((w) => qWords.has(w));
    });
    setRecallResults(matched.slice(0, 6));
  }

  // ── Derived state ──────────────────────────────────────────────────────────

  const counts = memories ? buildCounts(memories) : null;
  const last5 = memories?.slice(0, 5) ?? [];
  const total = memories?.length ?? 0;

  return (
    <Card className="border-[oklch(0.72_0.15_85)]/20">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Brain className="h-4 w-4 text-[oklch(0.72_0.15_85)]" />
            Basil&apos;s memory
          </CardTitle>
          <Link
            href="/dashboard/memory"
            className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            Manage <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* ── Category counts ──────────────────────────────────────────────── */}
        <div className="grid grid-cols-4 gap-2">
          {(["preference", "fact", "person", "context"] as MemoryKind[]).map((kind) => (
            <div
              key={kind}
              className="rounded-lg bg-muted/50 px-2 py-2 text-center"
            >
              <p className="text-[11px] text-muted-foreground">{KIND_LABELS[kind]}</p>
              <p className="text-base font-semibold tabular-nums">
                {counts ? counts[kind] : "–"}
              </p>
            </div>
          ))}
        </div>

        {/* ── Last 5 memories ──────────────────────────────────────────────── */}
        {memories !== null && (
          <div className="space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Recent
            </p>
            {last5.length === 0 ? (
              <p className="text-[12px] text-muted-foreground italic">
                No memories stored yet.
              </p>
            ) : (
              <ul className="space-y-1">
                {last5.map((m) => (
                  <li
                    key={m.id}
                    className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40 transition-colors"
                  >
                    <span className="inline-block mt-0.5 text-[10px] font-mono uppercase text-muted-foreground/60 w-14 shrink-0">
                      {m.kind}
                    </span>
                    <span className="text-[12px] leading-snug flex-1 line-clamp-2">
                      {m.entity ? (
                        <><span className="font-medium">{m.entity}: </span>{m.content}</>
                      ) : (
                        m.content
                      )}
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground/50 shrink-0 tabular-nums mt-0.5">
                      {relTime(m.updatedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {total > 5 && (
              <p className="text-[11px] text-muted-foreground pl-2">
                +{total - 5} more —{" "}
                <Link href="/dashboard/memory" className="text-[oklch(0.72_0.15_85)] hover:underline">
                  view all
                </Link>
              </p>
            )}
          </div>
        )}

        {/* ── Recall search ─────────────────────────────────────────────────── */}
        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Recall
          </p>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" />
            <input
              type="text"
              value={recallQuery}
              onChange={(e) => handleRecallChange(e.target.value)}
              placeholder="Search memories…"
              className="w-full h-8 rounded-lg border border-border bg-background pl-8 pr-3 text-[12px] placeholder:text-muted-foreground/50 focus:outline-none focus:border-[oklch(0.72_0.15_85)]/40 focus:ring-2 focus:ring-[oklch(0.72_0.15_85)]/10 transition-all"
            />
          </div>
          {recallResults !== null && (
            <div className="space-y-0.5 max-h-36 overflow-y-auto">
              {recallResults.length === 0 ? (
                <p className="text-[11px] text-muted-foreground italic px-1">No matches.</p>
              ) : (
                recallResults.map((m) => (
                  <div
                    key={m.id}
                    className="flex items-start gap-2 rounded-md px-2 py-1 bg-muted/30"
                  >
                    <span className="text-[10px] font-mono uppercase text-muted-foreground/60 w-14 shrink-0 mt-0.5">
                      {m.kind}
                    </span>
                    <span className="text-[11px] leading-snug line-clamp-2">
                      {m.entity ? (
                        <><span className="font-medium">{m.entity}: </span>{m.content}</>
                      ) : (
                        m.content
                      )}
                    </span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* ── Quick ingest ──────────────────────────────────────────────────── */}
        <form onSubmit={handleIngest} className="space-y-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Remember this
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={ingestText}
              onChange={(e) => setIngestText(e.target.value)}
              placeholder="I prefer… / Michael uses… / Project X is…"
              className="flex-1 h-8 rounded-lg border border-border bg-background px-3 text-[12px] placeholder:text-muted-foreground/50 focus:outline-none focus:border-[oklch(0.72_0.15_85)]/40 focus:ring-2 focus:ring-[oklch(0.72_0.15_85)]/10 transition-all"
              disabled={ingestLoading}
            />
            <button
              type="submit"
              disabled={!ingestText.trim() || ingestLoading}
              className={cn(
                "shrink-0 inline-flex items-center gap-1 rounded-lg px-3 h-8 text-[12px] font-medium transition-all",
                ingestSuccess
                  ? "bg-emerald-100 text-emerald-700"
                  : "bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)] hover:brightness-105 disabled:opacity-50"
              )}
            >
              {ingestLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : ingestSuccess ? (
                <><CheckCircle2 className="h-3 w-3" /> Saved</>
              ) : (
                <><Plus className="h-3 w-3" /> Save</>
              )}
            </button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
