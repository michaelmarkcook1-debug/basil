"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bot,
  CheckCircle2,
  FolderKanban,
  Loader2,
  Plus,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  X,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { relativeTime } from "@/lib/utils";
import type { CanonicalProject, ProjectPriority, ProjectStatus, ProjectTruthData } from "@/lib/projects/types";
import { renderSlackText } from "@/lib/slack/render";

const PRIORITY_STYLES: Record<ProjectPriority, string> = {
  critical: "bg-red-500/10 text-red-600 ring-1 ring-red-500/30",
  high: "bg-orange-500/10 text-orange-600 ring-1 ring-orange-500/30",
  medium: "bg-amber-500/10 text-amber-600 ring-1 ring-amber-500/30",
  low: "bg-muted text-muted-foreground",
};

const STATUS_STYLES: Record<ProjectStatus, string> = {
  blocked: "bg-red-500/10 text-red-600 ring-1 ring-red-500/30",
  stalled: "bg-orange-500/10 text-orange-600 ring-1 ring-orange-500/30",
  "needs-review": "bg-violet-500/10 text-violet-600 ring-1 ring-violet-500/30",
  moving: "bg-emerald-500/10 text-emerald-600 ring-1 ring-emerald-500/30",
  quiet: "bg-muted text-muted-foreground",
};

function StatCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: number | string;
  icon: typeof FolderKanban;
}) {
  return (
    <Card className="basil-card">
      <CardContent className="p-4 flex items-center justify-between">
        <div>
          <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            {label}
          </p>
          <p className="text-2xl font-semibold mt-1">{value}</p>
        </div>
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[oklch(0.72_0.15_85)]/10 text-[oklch(0.58_0.15_85)]">
          <Icon className="h-5 w-5" />
        </span>
      </CardContent>
    </Card>
  );
}

function ProjectCard({ project }: { project: CanonicalProject }) {
  const sourceList = Object.entries(project.sourceBreakdown)
    .sort((a, b) => b[1] - a[1])
    .map(([source, count]) => `${source} ${count}`);

  return (
    <Card className="basil-card overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-lg leading-tight">{project.name}</CardTitle>
              <Badge className={PRIORITY_STYLES[project.priority]}>{project.priority}</Badge>
              <Badge className={STATUS_STYLES[project.status]}>{project.status}</Badge>
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {project.summary}
            </p>
          </div>
          <p className="text-xs text-muted-foreground shrink-0">
            active {relativeTime(project.lastActiveAt)}
          </p>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-xl border border-border/70 bg-background/50 p-3">
          <div className="flex gap-2">
            <ArrowRight className="h-4 w-4 shrink-0 mt-0.5 text-[oklch(0.58_0.15_85)]" />
            <div>
              <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                Next best action
              </p>
              <p className="text-sm mt-1">{project.nextBestAction}</p>
            </div>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-4">
          <div className="rounded-lg bg-muted/40 p-3">
            <p className="text-[11px] text-muted-foreground uppercase tracking-[0.16em]">Actions</p>
            <p className="text-lg font-semibold">{project.openActionCount}</p>
          </div>
          <div className="rounded-lg bg-muted/40 p-3">
            <p className="text-[11px] text-muted-foreground uppercase tracking-[0.16em]">Decisions</p>
            <p className="text-lg font-semibold">{project.decisionCount}</p>
          </div>
          <div className="rounded-lg bg-muted/40 p-3">
            <p className="text-[11px] text-muted-foreground uppercase tracking-[0.16em]">Blockers</p>
            <p className="text-lg font-semibold">{project.blockerCount}</p>
          </div>
          <div className="rounded-lg bg-muted/40 p-3">
            <p className="text-[11px] text-muted-foreground uppercase tracking-[0.16em]">AI work</p>
            <p className="text-lg font-semibold">{project.aiWorkCount}</p>
          </div>
        </div>

        {project.riskNotes.length > 0 && (
          <div className="rounded-xl border border-red-200/70 bg-red-500/[0.04] p-3">
            <div className="flex items-start gap-2">
              <ShieldAlert className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
              <div>
                <p className="text-[11px] uppercase tracking-[0.18em] text-red-600 font-medium">
                  Risks / blockers
                </p>
                <ul className="mt-2 space-y-1.5">
                  {project.riskNotes.slice(0, 3).map((risk, idx) => (
                    <li key={idx} className="text-sm text-foreground/90 leading-relaxed">
                      {renderSlackText(risk)}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}

        <div className="space-y-2">
          <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            Source signals
          </p>
          <div className="flex flex-wrap gap-1.5">
            {sourceList.map((source) => (
              <Badge key={source} variant="secondary" className="text-xs">
                {source}
              </Badge>
            ))}
            {project.relatedPlatforms.map((platform) => (
              <Badge key={platform} variant="outline" className="text-xs gap-1">
                <Bot className="h-3 w-3" />
                {platform}
              </Badge>
            ))}
          </div>
        </div>

        <div className="divide-y divide-border/60 rounded-xl border border-border/70 overflow-hidden">
          {project.signals.slice(0, 5).map((signal) => (
            <div key={signal.id} className="p-3 bg-card/40">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium truncate">{renderSlackText(signal.title)}</p>
                <Badge variant="outline" className="text-[11px] shrink-0">
                  {signal.source}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed line-clamp-2">
                {renderSlackText(signal.summary)}
              </p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

interface CreateProjectForm {
  name: string;
  summary: string;
  priority: "critical" | "high" | "medium" | "low";
  nextBestAction: string;
}

export default function ProjectsPage() {
  const [data, setData] = useState<ProjectTruthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createForm, setCreateForm] = useState<CreateProjectForm>({
    name: "",
    summary: "",
    priority: "medium",
    nextBestAction: "",
  });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/projects", { cache: "no-store" });
      if (!res.ok) throw new Error("Could not build Project Truth Layer");
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load projects");
    } finally {
      setLoading(false);
    }
  }

  async function createProject() {
    if (!createForm.name.trim()) return;
    setCreating(true);
    setCreateError("");
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          name: createForm.name.trim(),
          summary: createForm.summary.trim() || undefined,
          priority: createForm.priority,
          nextBestAction: createForm.nextBestAction.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json() as { error?: string };
        setCreateError(body.error ?? "Failed to create project");
        return;
      }
      setShowCreateForm(false);
      setCreateForm({ name: "", summary: "", priority: "medium", nextBestAction: "" });
      await load();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Network error");
    } finally {
      setCreating(false);
    }
  }

  useEffect(() => { void load(); }, []);

  // Reload when the tab regains focus — keeps data in sync across multiple open tabs
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);  

  const metrics = useMemo(() => {
    const projects = data?.projects ?? [];
    return {
      total: projects.length,
      blocked: projects.filter((p) => p.status === "blocked").length,
      aiWork: projects.reduce((sum, p) => sum + p.aiWorkCount, 0),
      decisions: projects.reduce((sum, p) => sum + p.decisionCount, 0),
    };
  }, [data]);

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-6xl mx-auto">
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="space-y-2">
          <p className="basil-eyebrow flex items-center gap-2">
            <FolderKanban className="h-3.5 w-3.5" />
            Project Truth Layer
          </p>
          <h1 className="basil-display text-3xl sm:text-5xl leading-[1.05] text-foreground">
            What you are actually working on<span className="text-[oklch(0.72_0.15_85)]">.</span>
          </h1>
          <p className="text-sm text-muted-foreground max-w-2xl leading-relaxed">
            Basil clusters Slack, Linear, actions, decisions, memory, and AI work into one canonical project ledger. No more six assistants each inventing their own universe.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => setShowCreateForm((v) => !v)}
          >
            <Plus className="h-4 w-4" />
            Create project
          </Button>
          <Button onClick={load} disabled={loading} variant="outline" className="gap-2">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </Button>
        </div>
      </header>

      {error && (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-5 py-4 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Projects" value={metrics.total} icon={FolderKanban} />
        <StatCard label="Blocked" value={metrics.blocked} icon={AlertTriangle} />
        <StatCard label="AI work items" value={metrics.aiWork} icon={Sparkles} />
        <StatCard label="Decisions" value={metrics.decisions} icon={CheckCircle2} />
      </div>

      {data && (
        <Card className="basil-card">
          <CardContent className="p-4 flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Activity className="h-3.5 w-3.5" />
              Source counts:
            </span>
            <span>Manual {(data.sourceCounts as Record<string,number>).manual ?? 0}</span>
            <span>Actions {data.sourceCounts.actions}</span>
            <span>Decisions {data.sourceCounts.decisions}</span>
            <span>Memory {data.sourceCounts.memories}</span>
            <span>AI projects {data.sourceCounts.aiProjects}</span>
            <span>Slack {data.sourceCounts.slack}</span>
            <span>Linear {data.sourceCounts.linear}</span>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="rounded-2xl basil-card p-10 text-center text-sm text-muted-foreground">
          Building project truth layer…
        </div>
      ) : data && data.projects.length > 0 ? (
        <div className="space-y-4">
          {data.projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-2xl basil-card p-12 text-center">
            <FolderKanban className="h-12 w-12 mx-auto text-muted-foreground/30 mb-4" />
            <h2 className="basil-display text-2xl mb-2">No projects yet</h2>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              Create one manually using the button above, or connect Slack, Linear, and AI Projects so Basil can auto-detect active work.
            </p>
            <div className="mt-4">
              <Button
                size="sm"
                onClick={() => setShowCreateForm(true)}
                className="bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)] hover:bg-[oklch(0.78_0.12_85)] gap-2"
              >
                <Plus className="h-4 w-4" />
                Create project manually
              </Button>
            </div>
          </div>

          {showCreateForm && (
            <div className="rounded-2xl basil-card p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold">Create project manually</h3>
                <button
                  onClick={() => { setShowCreateForm(false); setCreateError(""); }}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label="Cancel"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {createError && (
                <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{createError}</p>
              )}

              <div className="space-y-3">
                <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
                  Project name <span className="text-red-500">*</span>
                  <Input
                    value={createForm.name}
                    onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder="e.g. TalentGenius v2"
                    required
                  />
                </label>

                <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
                  Summary
                  <Textarea
                    value={createForm.summary}
                    onChange={(e) => setCreateForm((f) => ({ ...f, summary: e.target.value }))}
                    placeholder="What is this project about?"
                    rows={2}
                  />
                </label>

                <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
                  Priority
                  <select
                    value={createForm.priority}
                    onChange={(e) => setCreateForm((f) => ({ ...f, priority: e.target.value as CreateProjectForm["priority"] }))}
                    className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[oklch(0.72_0.15_85)]"
                  >
                    <option value="critical">Critical</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </label>

                <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
                  Next best action
                  <Input
                    value={createForm.nextBestAction}
                    onChange={(e) => setCreateForm((f) => ({ ...f, nextBestAction: e.target.value }))}
                    placeholder="What should happen next?"
                  />
                </label>
              </div>

              <div className="flex gap-2 pt-1">
                <Button
                  size="sm"
                  onClick={createProject}
                  disabled={creating || !createForm.name.trim()}
                  className="gap-1.5"
                >
                  {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                  Create project
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { setShowCreateForm(false); setCreateError(""); }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
