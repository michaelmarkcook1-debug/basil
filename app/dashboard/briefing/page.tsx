"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Newspaper,
  Calendar,
  Mail,
  Hash,
  ListChecks,
  Scale,
  Zap,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ExtraContextInput,
  buildExtraContextFormData,
} from "@/components/extra-context-input";

interface Briefing {
  calendar: string | null;
  emails: string | null;
  slack: string | null;
  tasks: string | null;
  decisions: string | null;
  generatedAt: string;
}

type SectionKey = "calendar" | "emails" | "slack" | "tasks" | "decisions";

interface SectionDef {
  key: SectionKey;
  label: string;
  icon: typeof Calendar;
  /** Soft tinted card background */
  bg: string;
  /** Accent bar + icon background */
  accent: string;
  /** Icon & eyebrow color */
  fg: string;
  /** Ring color */
  ring: string;
}

const sections: SectionDef[] = [
  {
    key: "calendar",
    label: "Calendar",
    icon: Calendar,
    bg: "bg-[oklch(0.72_0.15_85)]/[0.04]",
    accent: "bg-[oklch(0.72_0.15_85)]",
    fg: "text-[oklch(0.58_0.15_85)]",
    ring: "ring-[oklch(0.72_0.15_85)]/25",
  },
  {
    key: "emails",
    label: "Inbox",
    icon: Mail,
    bg: "bg-blue-500/[0.04]",
    accent: "bg-blue-500",
    fg: "text-blue-600",
    ring: "ring-blue-500/25",
  },
  {
    key: "slack",
    label: "Slack",
    icon: Hash,
    bg: "bg-violet-500/[0.04]",
    accent: "bg-violet-500",
    fg: "text-violet-600",
    ring: "ring-violet-500/25",
  },
  {
    key: "tasks",
    label: "Open Tasks & Follow-ups",
    icon: ListChecks,
    bg: "bg-emerald-500/[0.04]",
    accent: "bg-emerald-500",
    fg: "text-emerald-600",
    ring: "ring-emerald-500/25",
  },
  {
    key: "decisions",
    label: "Decisions Needed",
    icon: Scale,
    bg: "bg-rose-500/[0.04]",
    accent: "bg-rose-500",
    fg: "text-rose-600",
    ring: "ring-rose-500/25",
  },
];

/** Split inline numbered lists like "1. foo 2. bar" into separate items */
function splitInlineNumbered(text: string): string[] {
  // Matches " 2. ", " 10. " etc. — but not things like "v1.0" or dates "Apr 2."
  // Requires: whitespace before, 1-2 digits, period, whitespace after, uppercase-ish letter follows
  const parts = text.split(/(?<=\s)(\d{1,2}\.\s+)/g);
  if (parts.length <= 1) return [text];

  // Rejoin markers with following text
  const items: string[] = [];
  // first chunk may be intro text before "1."
  let intro = parts[0];
  const firstMarkerIdx = intro.match(/^(\d{1,2}\.\s+)/) ? 0 : -1;

  if (firstMarkerIdx === -1) {
    // text might start with "1. ..." without leading whitespace
    const m = intro.match(/^(\d{1,2}\.\s+)([\s\S]*)$/);
    if (m) {
      intro = "";
      items.push(m[2].trim());
    }
  }

  for (let i = 1; i < parts.length; i += 2) {
    const content = parts[i + 1] ?? "";
    if (content.trim()) items.push(content.trim());
  }

  // If splitting produced nothing useful, fall back
  if (items.length === 0) return [text];
  return intro.trim() ? [intro.trim(), ...items] : items;
}

/** Render briefing paragraph with bullet lines promoted to list items */
function RichContent({ text }: { text: string }) {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);

  const blocks: Array<
    { type: "p"; text: string } | { type: "ul"; items: string[] }
  > = [];
  let currentList: string[] | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    const isBullet = /^[-•*]\s+/.test(line);
    const isNumberedStart = /^\d{1,2}\.\s+/.test(line);
    // Detect "1. ... 2. ..." inline lists
    const looksInlineNumbered =
      isNumberedStart && /\s\d{1,2}\.\s+/.test(line) ||
      (isNumberedStart && line.length > 120);

    if (isBullet) {
      const item = line.replace(/^[-•*]\s+/, "");
      if (!currentList) currentList = [];
      currentList.push(item);
    } else if (looksInlineNumbered) {
      // Split inline numbered list into separate items
      if (currentList) {
        blocks.push({ type: "ul", items: currentList });
        currentList = null;
      }
      const items = splitInlineNumbered(line);
      blocks.push({ type: "ul", items });
    } else if (isNumberedStart) {
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
          <p key={i} className="text-[18px] leading-[1.7] text-foreground/90">
            {b.text}
          </p>
        ) : (
          <ul key={i} className="space-y-3">
            {b.items.map((item, j) => (
              <li key={j} className="flex gap-3.5 text-[17px] leading-[1.6]">
                <span className="mt-2.5 h-2 w-2 shrink-0 rounded-full bg-current opacity-70" />
                <span className="text-foreground/90">{item}</span>
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}

export default function BriefingPage() {
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [extraNotes, setExtraNotes] = useState("");
  const [extraFiles, setExtraFiles] = useState<File[]>([]);
  const [extraUrls, setExtraUrls] = useState<string[]>([]);

  useEffect(() => {
    const cached = localStorage.getItem("sage-briefing");
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        const today = new Date().toLocaleDateString("en-CA", {
          timeZone: "Europe/London",
        });
        const cachedDate = parsed.generatedAt
          ? new Date(parsed.generatedAt).toLocaleDateString("en-CA", {
              timeZone: "Europe/London",
            })
          : "";
        if (cachedDate === today) {
          setBriefing(parsed);
        } else {
          localStorage.removeItem("sage-briefing");
        }
      } catch {
        /* ignore bad cache */
      }
    }
  }, []);

  async function generate() {
    setLoading(true);
    setError("");
    try {
      const hasExtras =
        extraNotes.trim().length > 0 ||
        extraFiles.length > 0 ||
        extraUrls.length > 0;
      const res = hasExtras
        ? await fetch("/api/generate/briefing", {
            method: "POST",
            body: buildExtraContextFormData(
              extraNotes,
              extraFiles,
              undefined,
              extraUrls
            ),
          })
        : await fetch("/api/generate/briefing", { method: "POST" });
      if (!res.ok) throw new Error("Generation failed");
      const data = await res.json();
      setBriefing(data);
      localStorage.setItem("sage-briefing", JSON.stringify(data));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  const today = new Date().toLocaleDateString("en-GB", {
    timeZone: "Europe/London",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return (
    <div className="p-4 sm:p-6 lg:p-10 space-y-8 max-w-5xl mx-auto">
      {/* Hero header */}
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="space-y-2">
          <p className="basil-eyebrow flex items-center gap-2 text-[13px]">
            <Newspaper className="h-3.5 w-3.5" /> Daily Briefing
          </p>
          <h1 className="basil-display text-5xl lg:text-6xl leading-[1.05] text-foreground">
            {today.split(",")[0]}
            <span className="text-[oklch(0.72_0.15_85)]">.</span>
          </h1>
          <p className="text-base text-muted-foreground">
            {today.split(",").slice(1).join(",").trim()} · Prepared by Basil
          </p>
        </div>
        <Button
          onClick={generate}
          disabled={loading}
          size="lg"
          className="bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)] hover:bg-[oklch(0.78_0.12_85)] gap-2 shadow-md shadow-[oklch(0.72_0.15_85)]/20 h-11 px-5"
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Generating…
            </>
          ) : (
            <>
              <Zap className="h-4 w-4" />
              {briefing ? "Regenerate" : "Generate briefing"}
            </>
          )}
        </Button>
      </header>

      <ExtraContextInput
        label="Want Basil to weigh in on something specific?"
        placeholder="e.g. 'Focus on the AG launch timeline', 'Here's my investor update draft — pull anything relevant', 'Attached notes from yesterday's 1:1'…"
        notes={extraNotes}
        onNotesChange={setExtraNotes}
        files={extraFiles}
        onFilesChange={setExtraFiles}
        urls={extraUrls}
        onUrlsChange={setExtraUrls}
        disabled={loading}
      />

      {error && (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-5 py-4 text-sm text-destructive">
          {error}
        </div>
      )}

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
              <Skeleton className="h-4 w-24 mb-4" />
              <Skeleton className="h-5 w-full mb-2" />
              <Skeleton className="h-5 w-11/12 mb-2" />
              <Skeleton className="h-5 w-4/5" />
            </div>
          ))}
        </div>
      )}

      {!loading && briefing && (
        <div className="space-y-5">
          {sections.map((s) => {
            const content = briefing[s.key];
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

          <div className="pt-2">
            <div className="basil-hairline" />
            <p className="text-sm text-muted-foreground text-center pt-4 font-mono tracking-wider uppercase">
              Prepared by Basil ·{" "}
              {new Date(briefing.generatedAt).toLocaleString("en-GB", {
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

      {!loading && !briefing && !error && (
        <div className="rounded-2xl basil-card ring-1 ring-foreground/[0.06] p-12 text-center">
          <Newspaper className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
          <h2 className="basil-display text-2xl mb-2">No briefing yet today</h2>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            Generate your executive briefing from today&apos;s calendar, inbox,
            Slack activity, open tasks, and pending decisions.
          </p>
        </div>
      )}
    </div>
  );
}
