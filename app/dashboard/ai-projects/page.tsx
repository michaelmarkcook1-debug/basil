"use client";

import { useCallback, useEffect, useState } from "react";
import {
  BrainCircuit,
  RefreshCw,
  Loader2,
  ExternalLink,
  Trash2,
  ChevronDown,
  Plus,
  X,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { relativeTime } from "@/lib/utils";
import type { AIProject, AIProjectsData, Category, Platform } from "@/lib/ai-projects/types";
import { PLATFORM_LABELS } from "@/lib/ai-projects/types";

// ── Styles helpers ────────────────────────────────────────────────────────────

const IMPORTANCE_STYLES: Record<string, string> = {
  critical: "bg-signal-critical-subtle text-signal-critical ring-1 ring-signal-critical/30",
  high:     "bg-signal-warning-subtle text-signal-warning ring-1 ring-signal-warning/30",
  medium:   "bg-signal-warning-subtle text-signal-warning ring-1 ring-signal-warning/30",
  low:      "bg-muted text-muted-foreground",
};

const IMPORTANCE_ORDER: Record<string, number> = {
  critical: 0, high: 1, medium: 2, low: 3,
};

const PLATFORM_BADGE_STYLES: Partial<Record<Platform, string>> = {
  "claude-code": "bg-signal-info-subtle text-signal-info",
  "claude-chat": "bg-signal-info-subtle text-signal-info",
  "claude-cowork": "bg-signal-info-subtle text-signal-info",
  "github":      "bg-zinc-500/10 text-zinc-600",
  "vercel":      "bg-zinc-900/10 text-zinc-800 dark:bg-zinc-100/10 dark:text-zinc-200",
  "linear":      "bg-signal-info-subtle text-signal-info",
  "chatgpt":     "bg-signal-positive-subtle text-signal-positive",
};

function platformBadgeStyle(platform: Platform): string {
  return PLATFORM_BADGE_STYLES[platform] ?? "bg-muted text-muted-foreground";
}

function effectiveCategory(p: AIProject): Category {
  return p.categoryOverride ?? p.category;
}

function effectiveImportance(p: AIProject) {
  return p.importanceOverride ?? p.importance;
}

type SortOption = "recency" | "importance" | "platform" | "name";

function sortProjects(projects: AIProject[], sort: SortOption): AIProject[] {
  return [...projects].sort((a, b) => {
    switch (sort) {
      case "importance": {
        const diff = (IMPORTANCE_ORDER[effectiveImportance(a)] ?? 3) - (IMPORTANCE_ORDER[effectiveImportance(b)] ?? 3);
        if (diff !== 0) return diff;
        return new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime();
      }
      case "platform":
        return a.platform.localeCompare(b.platform);
      case "name":
        return a.name.localeCompare(b.name);
      case "recency":
      default:
        return new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime();
    }
  });
}

// ── Platform status bar ───────────────────────────────────────────────────────

function PlatformStatusBar({ data }: { data: AIProjectsData }) {
  const allPlatforms = Object.values(data.platforms);
  return (
    <div className="flex gap-3 overflow-x-auto pb-1 scrollbar-hide">
      {allPlatforms.map((status) => (
        <div
          key={status.platform}
          className={cn(
            "shrink-0 flex flex-col items-center gap-1.5 rounded-xl border px-4 py-3 min-w-[90px]",
            status.connected && status.scraped
              ? "border-signal-warning-border bg-signal-warning-subtle/60"
              : "border-border bg-card"
          )}
        >
          {/* Traffic light dot */}
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              status.connected
                ? status.error
                  ? "bg-signal-critical"
                  : status.scraped
                    ? "bg-signal-warning"
                    : "bg-signal-positive"
                : "bg-muted-foreground/30"
            )}
          />
          <span className="text-xs font-medium text-center leading-tight">
            {status.label}
          </span>
          {status.connected && status.scraped && (
            <span className="text-xs text-signal-warning font-medium text-center leading-tight">
              scraped
            </span>
          )}
          {status.connected && status.itemCount !== undefined && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {status.itemCount} item{status.itemCount !== 1 ? "s" : ""}
            </span>
          )}
          {!status.connected && status.setupUrl && (
            <a
              href={status.setupUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-[var(--w-carbon)] hover:underline"
            >
              Setup
            </a>
          )}
          {status.error && (
            <span className="text-xs text-signal-critical text-center">{status.error}</span>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Project row ───────────────────────────────────────────────────────────────

function ProjectRow({
  project,
  onHide,
  onCategoryChange,
  scrapedPlatforms,
}: {
  project: AIProject;
  onHide: (id: string) => void;
  onCategoryChange: (id: string, category: Category) => void;
  scrapedPlatforms: Set<Platform>;
}) {
  const isScraped = scrapedPlatforms.has(project.platform);
  const [showPopover, setShowPopover] = useState(false);
  const imp = effectiveImportance(project);
  const hasRelated = (project.relatedProjectIds?.length ?? 0) > 0;

  return (
    <div className="relative flex items-start gap-3 py-3 border-b border-border/50 last:border-0 group">
      {/* Platform badge */}
      <div className="shrink-0 mt-0.5 flex flex-col items-start gap-0.5">
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-xs font-medium",
            platformBadgeStyle(project.platform)
          )}
        >
          {PLATFORM_LABELS[project.platform]}
        </span>
        {isScraped && (
          <span className="rounded px-1.5 py-0.5 text-xs font-medium bg-signal-warning-subtle text-signal-warning border border-signal-warning-border">
            scraped
          </span>
        )}
      </div>

      {/* Content */}
      <div
        className="flex-1 min-w-0 cursor-pointer"
        onClick={() => setShowPopover((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setShowPopover((v) => !v); }}
      >
        <p className="text-sm font-semibold leading-tight">{project.name}</p>
        <p className="text-xs text-muted-foreground italic mt-0.5 leading-relaxed line-clamp-2">
          {project.summary}
        </p>
        <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
          <span className={cn("rounded px-1.5 py-0.5 text-xs font-medium", IMPORTANCE_STYLES[imp] ?? IMPORTANCE_STYLES.low)}>
            {imp}
          </span>
          {hasRelated && (
            <span className="text-xs text-muted-foreground bg-muted rounded px-1.5 py-0.5">
              Related: {project.relatedProjectIds!.join(", ").substring(0, 40)}
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            Created {relativeTime(project.createdAt)} · active {relativeTime(project.lastActiveAt)}
          </span>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        {project.url && project.url !== "claude://" ? (
          <a href={project.url} target="_blank" rel="noreferrer" title="Open project" aria-label="Open project">
            <ExternalLink className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
          </a>
        ) : (
          <span className="text-xs text-muted-foreground px-1">Local</span>
        )}
        <button
          onClick={() => onHide(project.id)}
          title="Hide project"
          className="text-muted-foreground hover:text-signal-critical transition-colors"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Popover */}
      {showPopover && (
        <div className="absolute right-0 top-full z-10 mt-1 w-56 rounded-xl border border-border bg-card shadow-lg p-3 space-y-2">
          <p className="text-xs font-semibold text-foreground">
            {project.url && project.url !== "claude://"
              ? `Open in ${PLATFORM_LABELS[project.platform]}?`
              : "Local project"}
          </p>
          {project.url && project.url !== "claude://" && (
            <a
              href={project.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 rounded-lg bg-[var(--w-carbon)] px-3 py-1.5 text-xs font-medium text-[oklch(0.18_0.04_250)] hover:bg-[oklch(0.78_0.12_85)]"
            >
              <ExternalLink className="h-3 w-3" />
              Go
            </a>
          )}
          <div className="flex gap-1.5 pt-1">
            <button
              onClick={() => { onCategoryChange(project.id, "work"); setShowPopover(false); }}
              className="flex-1 rounded-lg border border-border px-2 py-1 text-xs bg-signal-info-subtle hover:text-signal-info hover:border-signal-info-border transition-colors"
            >
              Mark as work
            </button>
            <button
              onClick={() => { onCategoryChange(project.id, "personal"); setShowPopover(false); }}
              className="flex-1 rounded-lg border border-border px-2 py-1 text-xs bg-signal-info-subtle hover:text-signal-info hover:border-signal-info-border transition-colors"
            >
              Mark as personal
            </button>
          </div>
          <button
            onClick={() => setShowPopover(false)}
            className="w-full text-xs text-muted-foreground hover:text-foreground"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

// ── Project column ────────────────────────────────────────────────────────────

function ProjectColumn({
  title,
  projects,
  borderColor,
  count,
  onHide,
  onCategoryChange,
  scrapedPlatforms,
}: {
  title: string;
  projects: AIProject[];
  borderColor: string;
  count: number;
  onHide: (id: string) => void;
  onCategoryChange: (id: string, category: Category) => void;
  scrapedPlatforms: Set<Platform>;
}) {
  const [sort, setSort] = useState<SortOption>("recency");
  const sorted = sortProjects(projects, sort);

  return (
    <Card className={cn("shadow-sm border-l", borderColor)}>
      <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          {title}
          <Badge variant="secondary" className="text-xs">{count}</Badge>
        </CardTitle>
        {/* Sort dropdown */}
        <div className="relative">
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortOption)}
            className="appearance-none rounded-md border border-border bg-background px-2 py-1 pr-6 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-[var(--w-carbon)]"
          >
            <option value="recency">By recency</option>
            <option value="importance">By importance</option>
            <option value="platform">By platform</option>
            <option value="name">By name</option>
          </select>
          <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
        </div>
      </CardHeader>
      <CardContent>
        {sorted.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No projects here yet.</p>
        ) : (
          sorted.map((p) => (
            <ProjectRow key={p.id} project={p} onHide={onHide} onCategoryChange={onCategoryChange} scrapedPlatforms={scrapedPlatforms} />
          ))
        )}
      </CardContent>
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

interface LogWorkForm {
  platform: string;
  name: string;
  summary: string;
  importance: string;
  category: string;
}

export default function AIProjectsPage() {
  const [data, setData] = useState<AIProjectsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const [showLogForm, setShowLogForm] = useState(false);
  const [logForm, setLogForm] = useState<LogWorkForm>({
    platform: "claude-code",
    name: "",
    summary: "",
    importance: "medium",
    category: "work",
  });
  const [logging, setLogging] = useState(false);
  const [logError, setLogError] = useState("");

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

  async function handleLogWork() {
    if (!logForm.name.trim()) return;
    setLogging(true);
    setLogError("");
    try {
      const res = await fetch("/api/ai-projects/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: logForm.platform,
          projects: [{
            name: logForm.name.trim(),
            summary: logForm.summary.trim() || undefined,
            importance: logForm.importance,
            category: logForm.category,
            externalId: `manual-${Date.now()}`,
            lastActiveAt: new Date().toISOString(),
          }],
        }),
      });
      if (!res.ok) {
        const body = await res.json() as { error?: string };
        setLogError(body.error ?? "Failed to log work");
        return;
      }
      setShowLogForm(false);
      setLogForm({ platform: "claude-code", name: "", summary: "", importance: "medium", category: "work" });
      await load();
    } catch (e) {
      setLogError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLogging(false);
    }
  }

  useEffect(() => { void load(); }, [load]);

  // Reload when the tab regains focus — keeps data in sync across multiple open tabs
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

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

  async function handleHide(id: string) {
    try {
      const res = await fetch(`/api/ai-projects/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden: true }),
      });
      if (res.ok) {
        setData((prev) =>
          prev
            ? { ...prev, projects: prev.projects.map((p) => (p.id === id ? { ...p, hidden: true } : p)) }
            : prev
        );
      }
    } catch {
      // ignore
    }
  }

  async function handleCategoryChange(id: string, category: Category) {
    try {
      const res = await fetch(`/api/ai-projects/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category }),
      });
      if (res.ok) {
        const updated = await res.json();
        setData((prev) =>
          prev
            ? { ...prev, projects: prev.projects.map((p) => (p.id === id ? updated : p)) }
            : prev
        );
      }
    } catch {
      // ignore
    }
  }

  const visible = (data?.projects ?? []).filter((p) => !p.hidden);
  const workProjects = visible.filter((p) => effectiveCategory(p) === "work");
  const personalProjects = visible.filter((p) => effectiveCategory(p) === "personal");
  const unknownProjects = visible.filter((p) => effectiveCategory(p) === "unknown");

  const scrapedPlatforms = new Set<Platform>(
    data ? Object.values(data.platforms).filter((s) => s.scraped).map((s) => s.platform) : []
  );

  const connectedCount = data
    ? Object.values(data.platforms).filter((s) => s.connected).length
    : 0;

  return (
    <div className="wire p-4 sm:p-6 lg:p-10 space-y-8 max-w-[1200px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <BrainCircuit className="h-6 w-6 text-[var(--w-carbon)]" />
            AI Tools
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Track recent work across your AI and dev platforms.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => setShowLogForm((v) => !v)}
          >
            <Plus className="h-3.5 w-3.5" />
            Log AI work
          </Button>
          <Button
            onClick={handleSync}
            disabled={syncing}
            size="sm"
            className="gap-1.5 bg-[var(--w-carbon)] text-white hover:bg-[var(--w-ink)]"
          >
            {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Sync all
          </Button>
        </div>
      </div>

      {/* Log AI work form */}
      {showLogForm && (
        <div className="rounded-2xl border border-border bg-card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Log AI work manually</h3>
            <button
              onClick={() => { setShowLogForm(false); setLogError(""); }}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {logError && <p className="rounded-md bg-signal-critical-subtle px-3 py-2 text-xs text-signal-critical">{logError}</p>}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
              Platform
              <select
                value={logForm.platform}
                onChange={(e) => setLogForm((f) => ({ ...f, platform: e.target.value }))}
                className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--w-carbon)]"
              >
                <option value="claude-code">Claude Code</option>
                <option value="claude-chat">Claude Chat</option>
                <option value="claude-cowork">Claude Cowork</option>
                <option value="github">GitHub</option>
                <option value="vercel">Vercel</option>
                <option value="linear">Linear</option>
                <option value="chatgpt">ChatGPT</option>
                <option value="gemini">Gemini</option>
                <option value="codex">Codex</option>
              </select>
            </label>

            <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
              Project / task name <span className="text-signal-critical">*</span>
              <Input
                value={logForm.name}
                onChange={(e) => setLogForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="What were you working on?"
              />
            </label>

            <label className="block space-y-1.5 text-xs font-medium text-muted-foreground sm:col-span-2">
              Summary
              <Textarea
                value={logForm.summary}
                onChange={(e) => setLogForm((f) => ({ ...f, summary: e.target.value }))}
                placeholder="What did you do / are you doing?"
                rows={2}
              />
            </label>

            <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
              Importance
              <select
                value={logForm.importance}
                onChange={(e) => setLogForm((f) => ({ ...f, importance: e.target.value }))}
                className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--w-carbon)]"
              >
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </label>

            <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
              Category
              <select
                value={logForm.category}
                onChange={(e) => setLogForm((f) => ({ ...f, category: e.target.value }))}
                className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--w-carbon)]"
              >
                <option value="work">Work</option>
                <option value="personal">Personal</option>
                <option value="learning">Learning</option>
              </select>
            </label>
          </div>

          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={handleLogWork}
              disabled={logging || !logForm.name.trim()}
              className="gap-1.5"
            >
              {logging ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              Log work
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setShowLogForm(false); setLogError(""); }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Summary stats */}
      {!loading && data && (
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <span className="font-semibold text-foreground">{workProjects.length}</span> work
          <span className="text-border">·</span>
          <span className="font-semibold text-foreground">{personalProjects.length}</span> personal
          <span className="text-border">·</span>
          <span className="font-semibold text-foreground">{unknownProjects.length}</span> uncategorised
          <span className="text-border">·</span>
          across <span className="font-semibold text-foreground">{connectedCount}</span> platforms
          {data.lastSyncedAt && (
            <>
              <span className="text-border">·</span>
              synced {relativeTime(data.lastSyncedAt)}
            </>
          )}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground/40" />
        </div>
      ) : (
        <>
          {/* Platform status bar */}
          {data && (
            <section className="space-y-3">
              <p className="basil-eyebrow">Platforms</p>
              <PlatformStatusBar data={data} />
            </section>
          )}

          {/* Two-column layout: work + personal */}
          <section className="space-y-3">
            <p className="basil-eyebrow">Projects</p>
            <div className="grid gap-6 lg:grid-cols-2">
              <ProjectColumn
                title="Work Projects"
                projects={workProjects}
                borderColor="border-l-blue-500"
                count={workProjects.length}
                onHide={handleHide}
                onCategoryChange={handleCategoryChange}
                scrapedPlatforms={scrapedPlatforms}
              />
              <ProjectColumn
                title="Personal Projects"
                projects={personalProjects}
                borderColor="border-l-purple-500"
                count={personalProjects.length}
                onHide={handleHide}
                onCategoryChange={handleCategoryChange}
                scrapedPlatforms={scrapedPlatforms}
              />
            </div>
          </section>

          {/* Unknown / uncategorised */}
          {unknownProjects.length > 0 && (
            <section className="space-y-3">
              <p className="basil-eyebrow">Uncategorised — click to assign</p>
              <Card className="shadow-sm border-l border-l-[var(--w-manila)]">
                <CardContent className="pt-4">
                  {unknownProjects.map((p) => (
                    <ProjectRow
                      key={p.id}
                      project={p}
                      onHide={handleHide}
                      onCategoryChange={handleCategoryChange}
                      scrapedPlatforms={scrapedPlatforms}
                    />
                  ))}
                </CardContent>
              </Card>
            </section>
          )}

          {/* Empty state */}
          {workProjects.length === 0 && personalProjects.length === 0 && unknownProjects.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <BrainCircuit className="h-12 w-12 text-muted-foreground/30 mb-4" />
              <h2 className="text-lg font-medium">No AI projects tracked yet</h2>
              <p className="text-sm text-muted-foreground mt-1 max-w-sm">
                No AI projects tracked yet — sync a platform above or log work manually.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
