"use client";

import { useCallback, useEffect, useState } from "react";
import { BrainCircuit, RefreshCw, Loader2, ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { relativeTime } from "@/lib/utils";
import type { AIProject, AIProjectsData, Platform } from "@/lib/ai-projects/types";

// ── Helpers ──────────────────────────────────────────────────────────────────

const IMPORTANCE_STYLES: Record<string, string> = {
  critical: "bg-red-500/10 text-red-600 ring-1 ring-red-500/30",
  high:     "bg-orange-500/10 text-orange-600 ring-1 ring-orange-500/30",
  medium:   "bg-amber-500/10 text-amber-600 ring-1 ring-amber-500/30",
  low:      "bg-muted text-muted-foreground",
};

const PLATFORM_BADGE_STYLES: Partial<Record<Platform, string>> = {
  "claude-code": "bg-violet-500/10 text-violet-600",
  "claude-chat": "bg-violet-500/10 text-violet-500",
  "github":      "bg-zinc-500/10 text-zinc-600",
  "vercel":      "bg-zinc-900/10 text-zinc-800 dark:bg-zinc-100/10 dark:text-zinc-200",
  "linear":      "bg-violet-500/10 text-violet-600",
  "chatgpt":     "bg-emerald-500/10 text-emerald-600",
};

function platformBadgeStyle(platform: Platform): string {
  return PLATFORM_BADGE_STYLES[platform] ?? "bg-muted text-muted-foreground";
}

function platformLabel(platform: Platform): string {
  const labels: Record<Platform, string> = {
    "claude-code":   "Claude Code",
    "claude-chat":   "Claude.ai",
    "claude-cowork": "Claude Cowork",
    "github":        "GitHub",
    "vercel":        "Vercel",
    "linear":        "Linear",
    "chatgpt":       "ChatGPT",
    "gemini":        "Gemini",
    "perplexity":    "Perplexity",
    "grok":          "Grok",
    "codex":         "Codex",
  };
  return labels[platform] ?? platform;
}

function effectiveCategory(p: AIProject) {
  return p.categoryOverride ?? p.category;
}

function effectiveImportance(p: AIProject) {
  return p.importanceOverride ?? p.importance;
}

const IMPORTANCE_ORDER: Record<string, number> = {
  critical: 0, high: 1, medium: 2, low: 3,
};

// ── Sub-components ────────────────────────────────────────────────────────────

function ProjectRow({ project }: { project: AIProject }) {
  const imp = effectiveImportance(project);
  const hasRelated = (project.relatedProjectIds?.length ?? 0) > 0;

  return (
    <div className="flex items-start gap-3 py-3 border-b border-border/50 last:border-0 group">
      {/* Platform badge */}
      <span
        className={cn(
          "shrink-0 mt-0.5 rounded px-1.5 py-0.5 text-[11px] font-medium",
          platformBadgeStyle(project.platform)
        )}
      >
        {platformLabel(project.platform)}
      </span>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold leading-tight truncate">{project.name}</p>
        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed line-clamp-2">
          {project.summary}
        </p>
        <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
          {/* Importance badge */}
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[11px] font-medium",
              IMPORTANCE_STYLES[imp] ?? IMPORTANCE_STYLES.low
            )}
          >
            {imp}
          </span>
          {/* Related pill */}
          {hasRelated && (
            <span className="text-[11px] text-muted-foreground bg-muted rounded px-1.5 py-0.5">
              Related to {project.relatedProjectIds!.length} project{project.relatedProjectIds!.length !== 1 ? "s" : ""}
            </span>
          )}
          {/* Dates */}
          <span className="text-[11px] text-muted-foreground">
            active {relativeTime(project.lastActiveAt)}
          </span>
        </div>
      </div>

      {/* External link */}
      {project.url && project.url !== "claude://" ? (
        <a
          href={project.url}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 mt-1 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
          title="Open project"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      ) : (
        <span className="shrink-0 mt-1 opacity-0 group-hover:opacity-50 transition-opacity">
          <span className="text-[10px] text-muted-foreground">Local</span>
        </span>
      )}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-start gap-3 py-3 border-b border-border/50 last:border-0">
          <Skeleton className="h-5 w-20 rounded shrink-0" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main card ─────────────────────────────────────────────────────────────────

export function AIProjectsCard() {
  const [data, setData] = useState<AIProjectsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/ai-projects", { cache: "no-store" });
      if (res.ok) setData(await res.json());
    } catch {
      // non-fatal
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleSync() {
    setSyncing(true);
    try {
      const res = await fetch("/api/ai-projects", { method: "POST" });
      if (res.ok) setData(await res.json());
    } catch {
      // ignore
    } finally {
      setSyncing(false);
    }
  }

  const workProjects = (data?.projects ?? [])
    .filter((p) => !p.hidden && (effectiveCategory(p) === "work"))
    .sort((a, b) => {
      const diff = (IMPORTANCE_ORDER[effectiveImportance(a)] ?? 3) - (IMPORTANCE_ORDER[effectiveImportance(b)] ?? 3);
      if (diff !== 0) return diff;
      return new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime();
    })
    .slice(0, 10);

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <BrainCircuit className="h-4 w-4 text-[oklch(0.72_0.15_85)]" />
          AI work projects
        </CardTitle>
        <div className="flex items-center gap-2">
          {data?.lastSyncedAt && (
            <span className="text-[11px] text-muted-foreground hidden sm:inline">
              synced {relativeTime(data.lastSyncedAt)}
            </span>
          )}
          <button
            onClick={handleSync}
            disabled={syncing}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-[oklch(0.72_0.15_85)] transition-colors"
            title="Force sync all platforms"
          >
            {syncing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            <span className="hidden sm:inline">Sync</span>
          </button>
        </div>
      </CardHeader>

      <CardContent>
        {loading ? (
          <LoadingSkeleton />
        ) : workProjects.length === 0 ? (
          <div className="py-8 text-center">
            <BrainCircuit className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              No work projects tracked yet
            </p>
            <p className="text-xs text-muted-foreground/70 mt-1">
              Connect platforms in{" "}
              <a href="/dashboard/ai-projects" className="underline hover:text-foreground">
                AI Projects
              </a>{" "}
              to get started.
            </p>
          </div>
        ) : (
          <div>
            {workProjects.map((p) => (
              <ProjectRow key={p.id} project={p} />
            ))}
            {workProjects.length >= 10 && (
              <div className="pt-2 text-center">
                <a
                  href="/dashboard/ai-projects"
                  className="text-xs text-[oklch(0.72_0.15_85)] hover:underline"
                >
                  View all projects →
                </a>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
