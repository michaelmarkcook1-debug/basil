"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  BarChart3,
  Zap,
  Copy,
  Check,
  Calendar,
  ListChecks,
  Scale,
  AlertTriangle,
  Users,
  ArrowRight,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";

import type { Digest } from "@/lib/types/briefing";

type SectionKey =
  | "majorMeetings"
  | "whatChanged"
  | "decisionsLog"
  | "blockers"
  | "relationshipSignals"
  | "nextWeekNeeds";

interface SectionDef {
  key: SectionKey;
  label: string;
  icon: typeof Calendar;
  bg: string;
  accent: string;
  fg: string;
  ring: string;
}

const sections: SectionDef[] = [
  {
    key: "majorMeetings",
    label: "Major Meetings",
    icon: Calendar,
    bg: "bg-gold/[0.04]",
    accent: "bg-gold",
    fg: "text-[oklch(0.58_0.15_85)]",
    ring: "ring-gold/25",
  },
  {
    key: "whatChanged",
    label: "What Changed",
    icon: ListChecks,
    bg: "bg-signal-positive/[0.04]",
    accent: "bg-signal-positive",
    fg: "text-signal-positive",
    ring: "ring-signal-positive/25",
  },
  {
    key: "decisionsLog",
    label: "Decisions",
    icon: Scale,
    bg: "bg-signal-info/[0.04]",
    accent: "bg-signal-info",
    fg: "text-signal-info",
    ring: "ring-signal-info/25",
  },
  {
    key: "blockers",
    label: "Blockers & Risks",
    icon: AlertTriangle,
    bg: "bg-signal-critical/[0.04]",
    accent: "bg-signal-critical",
    fg: "text-signal-critical",
    ring: "ring-signal-critical/25",
  },
  {
    key: "relationshipSignals",
    label: "Relationship Signals",
    icon: Users,
    bg: "bg-signal-positive/[0.04]",
    accent: "bg-signal-positive",
    fg: "text-signal-positive",
    ring: "ring-signal-positive/25",
  },
  {
    key: "nextWeekNeeds",
    label: "Next Week Needs",
    icon: ArrowRight,
    bg: "bg-signal-warning/[0.04]",
    accent: "bg-signal-warning",
    fg: "text-signal-warning",
    ring: "ring-signal-warning/25",
  },
];

/** Render digest section text with bullet/numbered lines promoted to list items */
function RichContent({ text }: { text: string }) {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);

  const blocks: Array<
    { type: "p"; text: string } | { type: "ul"; items: string[] }
  > = [];
  let currentList: string[] | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    const isBullet = /^[-•*]\s+/.test(line);
    const isNumbered = /^\d{1,2}\.\s+/.test(line);

    if (isBullet) {
      const item = line.replace(/^[-•*]\s+/, "");
      if (!currentList) currentList = [];
      currentList.push(item);
    } else if (isNumbered) {
      const item = line.replace(/^\d{1,2}\.\s+/, "");
      if (!currentList) currentList = [];
      currentList.push(item);
    } else {
      if (currentList) {
        blocks.push({ type: "ul", items: currentList });
        currentList = null;
      }
      blocks.push({ type: "p", text: line });
    }
  }
  if (currentList) blocks.push({ type: "ul", items: currentList });

  return (
    <div className="space-y-3">
      {blocks.map((b, i) =>
        b.type === "p" ? (
          <p key={i} className="text-[17px] leading-[1.7] text-foreground/90">
            {b.text}
          </p>
        ) : (
          <ul key={i} className="space-y-2.5">
            {b.items.map((item, j) => (
              <li key={j} className="flex gap-3 text-[16px] leading-[1.6]">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-70" />
                <span className="text-foreground/90">{item}</span>
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}

export default function DigestPage() {
  const [digest, setDigest] = useState<Digest | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  // Load cached digest from the server on mount so it persists across tab
  // navigation. localStorage is kept as a fast client-side fallback to avoid
  // a flash of the empty state while the fetch is in flight.
  useEffect(() => {
    const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;

    // Optimistic restore from localStorage while the API call is in flight
    try {
      const lsRaw = localStorage.getItem("sage-digest-v3");
      if (lsRaw) {
        const lsParsed = JSON.parse(lsRaw);
        const generated = lsParsed?.generatedAt ? new Date(lsParsed.generatedAt).getTime() : 0;
        if (generated && Date.now() - generated <= SIX_DAYS_MS) setDigest(lsParsed);
        else localStorage.removeItem("sage-digest-v3");
      }
    } catch { /* ignore */ }

    // Authoritative load from server — this is the source of truth
    fetch("/api/generate/digest", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) {
          setDigest(data);
          localStorage.setItem("sage-digest-v3", JSON.stringify(data));
        }
      })
      .catch((e: unknown) => {
        // Network error — keep localStorage state as fallback
        console.error("[basil-fetch] network_error", { route: "/api/generate/digest", component: "DigestPage", error: e instanceof Error ? e.message : String(e) });
      });
  }, []);

  async function generate() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/generate/digest", { method: "POST" });
      if (!res.ok) throw new Error("Generation failed");
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setDigest(data);
      localStorage.setItem("sage-digest-v3", JSON.stringify(data));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function copyToClipboard() {
    if (!digest) return;
    const lines: string[] = ["# Weekly Summary\n"];
    for (const s of sections) {
      const content = digest[s.key];
      if (content) lines.push(`## ${s.label}\n\n${content}\n`);
    }
    lines.push(
      `---\nPrepared by Basil · ${new Date(digest.generatedAt).toLocaleString("en-GB", { timeZone: "Europe/London" })}`
    );
    await navigator.clipboard.writeText(lines.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // Use week range returned from the API (computed server-side in user's timezone).
  // Fall back to client-side computation if no digest exists yet.
  const weekLabel = (() => {
    if (digest?.weekStart && digest?.weekEnd) {
      return `${digest.weekStart} – ${digest.weekEnd}`;
    }
    // Client-side fallback (before first generation)
    const d   = new Date();
    const dow = d.getDay();
    const mon = new Date(d);
    mon.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    const fmt = (dt: Date) =>
      dt.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    return `${fmt(mon)} – ${fmt(sun)}`;
  })();

  return (
    <div className="p-4 sm:p-6 lg:p-10 space-y-8 max-w-4xl mx-auto">
      {/* Header */}
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="space-y-2">
          <p className="basil-eyebrow flex items-center gap-2 text-[13px]">
            <BarChart3 className="h-3.5 w-3.5" /> Weekly Summary
          </p>
          <h1 className="basil-display text-3xl sm:text-5xl lg:text-6xl leading-[1.05] text-foreground">
            This Week<span className="text-gold">.</span>
          </h1>
          <p className="text-base text-muted-foreground">
            {weekLabel} · Prepared by Basil
          </p>
        </div>
        <div className="flex items-center gap-2">
          {digest && (
            <Button
              size="lg"
              variant="outline"
              onClick={copyToClipboard}
              className="gap-2 h-11 px-5"
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          )}
          <Button
            onClick={generate}
            disabled={loading}
            size="lg"
            className="bg-gold text-[oklch(0.18_0.04_250)] hover:bg-[oklch(0.78_0.12_85)] gap-2 shadow-md shadow-gold/20 h-11 px-5"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Generating…
              </>
            ) : (
              <>
                <Zap className="h-4 w-4" />
                {digest ? "Regenerate" : "Generate summary"}
              </>
            )}
          </Button>
        </div>
      </header>

      {error && (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-5 py-4 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Skeleton while loading */}
      {loading && (
        <div className="space-y-4">
          {sections.map((s) => (
            <div
              key={s.key}
              className={cn(
                "relative overflow-hidden rounded-2xl ring-1 p-7 basil-card",
                s.ring
              )}
            >
              <span className={cn("absolute left-0 top-0 bottom-0 w-1", s.accent)} />
              <Skeleton className="h-4 w-32 mb-4" />
              <Skeleton className="h-5 w-full mb-2" />
              <Skeleton className="h-5 w-10/12 mb-2" />
              <Skeleton className="h-5 w-4/5" />
            </div>
          ))}
        </div>
      )}

      {/* Content */}
      {!loading && digest && (
        <div className="space-y-5">
          {sections.map((s) => {
            const content = digest[s.key];
            if (!content) return null;
            const Icon = s.icon;
            return (
              <article
                key={s.key}
                className={cn(
                  "relative overflow-hidden rounded-2xl ring-1 basil-card transition-shadow hover:shadow-lg",
                  s.ring,
                  s.bg
                )}
              >
                {/* Accent bar */}
                <span className={cn("absolute left-0 top-0 bottom-0 w-1.5", s.accent)} />

                <div className="p-7 pl-9 lg:p-9 lg:pl-11">
                  <header className="flex items-center gap-3 mb-5">
                    <span
                      className={cn(
                        "flex h-9 w-9 items-center justify-center rounded-lg shadow-sm",
                        s.accent
                      )}
                    >
                      <Icon className="h-4 w-4 text-white" />
                    </span>
                    <h2
                      className={cn(
                        "text-[13px] font-semibold uppercase tracking-[0.22em]",
                        s.fg
                      )}
                    >
                      {s.label}
                    </h2>
                  </header>

                  <div className={cn(s.fg)}>
                    <RichContent text={content} />
                  </div>
                </div>
              </article>
            );
          })}

          {/* Footer */}
          <div className="pt-2">
            <div className="basil-hairline" />
            <p className="text-sm text-muted-foreground text-center pt-4 font-mono tracking-wider uppercase">
              Prepared by Basil ·{" "}
              {new Date(digest.generatedAt).toLocaleString("en-GB", {
                timeZone: "Europe/London",
                weekday: "short",
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loading && !digest && !error && (
        <div className="rounded-2xl basil-card ring-1 ring-foreground/[0.06] p-12 text-center">
          <BarChart3 className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
          <h2 className="basil-display text-2xl mb-2">No summary yet this week</h2>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            Generate your weekly summary from calendar, email, Slack, tracked actions, decisions, and Basil&apos;s memory.
          </p>
        </div>
      )}
    </div>
  );
}
