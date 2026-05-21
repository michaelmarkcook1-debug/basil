"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Triangle,
  ExternalLink,
  Plus,
  X,
  ChevronDown,
  Circle,
  AlertCircle,
  Clock,
  RefreshCw,
  Pencil,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { LinearIssue, LinearTeam, LinearWorkflowState } from "@/lib/linear/client";

// ── Priority helpers ───────────────────────────────────────────────────────

const PRIORITY_LABELS: Record<number, string> = {
  0: "None",
  1: "Urgent",
  2: "High",
  3: "Normal",
  4: "Low",
};

function PriorityDot({ priority, className }: { priority: number; className?: string }) {
  const color =
    priority === 1
      ? "text-red-500"
      : priority === 2
      ? "text-orange-500"
      : priority === 3
      ? "text-amber-500"
      : priority === 4
      ? "text-slate-400"
      : "text-slate-300";
  return <Circle className={cn("h-2.5 w-2.5 fill-current", color, className)} />;
}

// ── State chip ─────────────────────────────────────────────────────────────

function StateChip({ state }: { state: { name: string; type: string } }) {
  const cls =
    state.type === "completed"
      ? "text-green-600 bg-green-50 border-green-200"
      : state.type === "started"
      ? "text-blue-600 bg-blue-50 border-blue-200"
      : state.type === "cancelled"
      ? "text-slate-400 bg-slate-100 border-slate-200"
      : state.type === "triage"
      ? "text-purple-600 bg-purple-50 border-purple-200"
      : "text-slate-600 bg-slate-100 border-slate-200";
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium", cls)}>
      {state.name}
    </span>
  );
}

// ── Status filter options ──────────────────────────────────────────────────

const STATUS_FILTERS = [
  { value: "all", label: "All" },
  { value: "started", label: "In Progress" },
  { value: "unstarted", label: "Todo" },
  { value: "triage", label: "Backlog" },
  { value: "completed", label: "Done" },
] as const;

type StatusFilterValue = (typeof STATUS_FILTERS)[number]["value"];

// ── New issue form ─────────────────────────────────────────────────────────

interface NewIssueForm {
  teamId: string;
  title: string;
  description: string;
  stateId: string;
  priority: number;
  dueDate: string;
}

const EMPTY_NEW_ISSUE: NewIssueForm = {
  teamId: "",
  title: "",
  description: "",
  stateId: "",
  priority: 0,
  dueDate: "",
};

// ── Edit panel state ───────────────────────────────────────────────────────

interface EditForm {
  title: string;
  description: string;
  stateId: string;
  priority: number;
  dueDate: string;
}

// ── Issue list item ────────────────────────────────────────────────────────

function IssueCard({
  issue,
  onSelect,
  selected,
}: {
  issue: LinearIssue;
  onSelect: (issue: LinearIssue) => void;
  selected: boolean;
}) {
  return (
    <Card
      className={cn(
        "rounded-lg border border-border/60 cursor-pointer transition-all hover:border-border group",
        selected && "border-[oklch(0.72_0.15_85)]/40 bg-[oklch(0.72_0.15_85)]/[0.03]"
      )}
      onClick={() => onSelect(issue)}
    >
      <CardContent className="p-3 flex items-center gap-3">
        {/* Priority dot */}
        <PriorityDot priority={issue.priority} className="shrink-0" />

        {/* Identifier */}
        <span className="font-mono text-[11px] text-muted-foreground shrink-0 min-w-[52px]">
          {issue.identifier}
        </span>

        {/* Title */}
        <span className="flex-1 text-sm text-foreground truncate leading-snug">
          {issue.title}
        </span>

        {/* Right side */}
        <div className="flex items-center gap-2 shrink-0">
          {issue.dueDate && (
            <span className="hidden sm:flex items-center gap-1 text-[11px] text-muted-foreground">
              <Clock className="h-3 w-3" />
              {issue.dueDate}
            </span>
          )}
          <span className="hidden md:block text-[11px] text-muted-foreground">
            {issue.team.name}
          </span>
          <StateChip state={issue.state} />
          <Pencil className="h-3 w-3 text-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
      </CardContent>
    </Card>
  );
}

// ── Skeleton cards ─────────────────────────────────────────────────────────

function SkeletonCards() {
  return (
    <div className="space-y-2">
      {[1, 2, 3, 4, 5].map((i) => (
        <Card key={i} className="rounded-lg border border-border/60">
          <CardContent className="p-3 flex items-center gap-3">
            <Skeleton className="h-2.5 w-2.5 rounded-full shrink-0" />
            <Skeleton className="h-3 w-14 shrink-0" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

export default function LinearPage() {
  const [issues, setIssues] = useState<LinearIssue[]>([]);
  const [teams, setTeams] = useState<LinearTeam[]>([]);
  const [states, setStates] = useState<LinearWorkflowState[]>([]);
  const [loading, setLoading] = useState(true);
  const [notConnected, setNotConnected] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Filters
  const [teamFilter, setTeamFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>("all");
  const [assigneeIsMe, setAssigneeIsMe] = useState(true);

  // Detail/edit panel
  const [selectedIssue, setSelectedIssue] = useState<LinearIssue | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({
    title: "",
    description: "",
    stateId: "",
    priority: 0,
    dueDate: "",
  });
  const [saving, setSaving] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);

  // New issue form
  const [showNewForm, setShowNewForm] = useState(false);
  const [newForm, setNewForm] = useState<NewIssueForm>(EMPTY_NEW_ISSUE);
  const [creating, setCreating] = useState(false);

  // Panel states for team-specific workflow states
  const [panelStates, setPanelStates] = useState<LinearWorkflowState[]>([]);

  // Load teams on mount
  useEffect(() => {
    fetch("/api/linear/teams")
      .then(async (res) => {
        if (res.status === 503) { setNotConnected(true); return; }
        if (!res.ok) return;
        const data = (await res.json()) as { teams: LinearTeam[] };
        setTeams(data.teams);
      })
      .catch(() => {});
  }, []);

  // Load workflow states (all) on mount
  useEffect(() => {
    fetch("/api/linear/states")
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { states: LinearWorkflowState[] };
        setStates(data.states);
      })
      .catch(() => {});
  }, []);

  // Load issues when filters change
  const loadIssues = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (teamFilter !== "all") params.set("teamId", teamFilter);
      if (statusFilter !== "all") params.set("stateType", statusFilter);
      if (assigneeIsMe) params.set("assigneeIsMe", "true");

      const res = await fetch(`/api/linear/issues?${params.toString()}`);
      if (res.status === 503) { setNotConnected(true); setLoading(false); return; }
      if (!res.ok) { setLoading(false); return; }
      const data = (await res.json()) as { issues: LinearIssue[] };
      setIssues(data.issues);
      setNotConnected(false);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [teamFilter, statusFilter, assigneeIsMe]);

  useEffect(() => { void loadIssues(); }, [loadIssues]);

  // When an issue is selected, load states for that team
  useEffect(() => {
    if (!selectedIssue) return;
    const teamId = teams.find((t) => t.name === selectedIssue.team.name)?.id;
    if (!teamId) {
      setPanelStates(states);
      return;
    }
    fetch(`/api/linear/states?teamId=${teamId}`)
      .then(async (res) => {
        if (!res.ok) { setPanelStates(states); return; }
        const data = (await res.json()) as { states: LinearWorkflowState[] };
        setPanelStates(data.states);
      })
      .catch(() => setPanelStates(states));
  }, [selectedIssue, teams, states]);

  function openPanel(issue: LinearIssue) {
    setSelectedIssue(issue);
    const currentState = states.find((s) => s.name === issue.state.name);
    setEditForm({
      title: issue.title,
      description: issue.description ?? "",
      stateId: currentState?.id ?? "",
      priority: issue.priority,
      dueDate: issue.dueDate ?? "",
    });
    setEditingTitle(false);
  }

  function closePanel() {
    setSelectedIssue(null);
    setEditingTitle(false);
  }

  async function handleSave() {
    if (!selectedIssue) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        title: editForm.title,
        description: editForm.description || undefined,
        priority: editForm.priority,
        dueDate: editForm.dueDate || null,
      };
      if (editForm.stateId) body.stateId = editForm.stateId;

      const res = await fetch(`/api/linear/issues/${selectedIssue.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = (await res.json()) as { issue: LinearIssue };
        // Optimistic update in list
        setIssues((prev) => prev.map((i) => (i.id === data.issue.id ? data.issue : i)));
        setSelectedIssue(data.issue);
        const newState = panelStates.find((s) => s.id === editForm.stateId);
        if (newState) {
          setEditForm((f) => ({ ...f }));
        }
      }
    } catch {
      // silent
    } finally {
      setSaving(false);
    }
  }

  async function handleCreate() {
    if (!newForm.title.trim() || !newForm.teamId) return;
    setCreating(true);
    try {
      const body: Record<string, unknown> = {
        title: newForm.title,
        teamId: newForm.teamId,
        description: newForm.description || undefined,
        priority: newForm.priority || undefined,
        dueDate: newForm.dueDate || null,
      };
      if (newForm.stateId) body.stateId = newForm.stateId;

      const res = await fetch("/api/linear/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = (await res.json()) as { issue: LinearIssue };
        setIssues((prev) => [data.issue, ...prev]);
        setNewForm(EMPTY_NEW_ISSUE);
        setShowNewForm(false);
      }
    } catch {
      // silent
    } finally {
      setCreating(false);
    }
  }

  async function handleRefresh() {
    setRefreshing(true);
    await loadIssues();
    setRefreshing(false);
  }

  // New form team-specific states
  const newFormStates = newForm.teamId
    ? states.filter((s) => s.team.id === newForm.teamId)
    : states;

  if (notConnected) {
    return (
      <div className="p-4 sm:p-6 lg:p-8">
        <header className="flex items-center gap-3 mb-8">
          <Triangle className="h-5 w-5 text-[oklch(0.72_0.15_85)]" />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Linear</h1>
            <p className="text-sm text-muted-foreground mt-0.5">Issues, projects and blockers</p>
          </div>
        </header>
        <Card className="rounded-lg border border-border/60">
          <CardContent className="py-12 text-center space-y-3">
            <AlertCircle className="h-10 w-10 mx-auto text-muted-foreground/30" />
            <p className="text-sm font-medium">Linear not connected</p>
            <p className="text-sm text-muted-foreground">
              Add your Linear API key in{" "}
              <a href="/dashboard/settings" className="text-[oklch(0.72_0.15_85)] hover:underline">
                Settings
              </a>{" "}
              to get started.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-5">
      {/* Header */}
      <header className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Triangle className="h-5 w-5 text-[oklch(0.72_0.15_85)] shrink-0" />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Linear</h1>
            <p className="text-sm text-muted-foreground mt-0.5">Issues, projects and blockers</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="text-muted-foreground/60 hover:text-muted-foreground transition-colors"
            title="Refresh"
          >
            <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
          </button>
          <Button
            size="sm"
            className="bg-[oklch(0.72_0.15_85)] hover:bg-[oklch(0.78_0.12_85)] text-[oklch(0.18_0.04_250)] gap-1.5"
            onClick={() => {
              setShowNewForm((v) => !v);
              if (teams.length > 0 && !newForm.teamId) {
                setNewForm((f) => ({ ...f, teamId: teams[0].id }));
              }
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            New Issue
          </Button>
        </div>
      </header>

      {/* New issue form */}
      {showNewForm && (
        <Card className="rounded-lg border border-[oklch(0.72_0.15_85)]/30">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">New Issue</p>
              <button
                onClick={() => { setShowNewForm(false); setNewForm(EMPTY_NEW_ISSUE); }}
                className="text-muted-foreground/50 hover:text-muted-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex gap-2 flex-wrap">
              <select
                value={newForm.teamId}
                onChange={(e) => setNewForm((f) => ({ ...f, teamId: e.target.value, stateId: "" }))}
                className="h-9 rounded-md border border-border bg-background px-3 text-sm"
              >
                <option value="">Select team…</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              <select
                value={newForm.priority}
                onChange={(e) => setNewForm((f) => ({ ...f, priority: Number(e.target.value) }))}
                className="h-9 rounded-md border border-border bg-background px-3 text-sm"
              >
                {Object.entries(PRIORITY_LABELS).map(([val, label]) => (
                  <option key={val} value={val}>{label}</option>
                ))}
              </select>
              {newFormStates.length > 0 && (
                <select
                  value={newForm.stateId}
                  onChange={(e) => setNewForm((f) => ({ ...f, stateId: e.target.value }))}
                  className="h-9 rounded-md border border-border bg-background px-3 text-sm"
                >
                  <option value="">Default state</option>
                  {newFormStates.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              )}
              <Input
                type="date"
                value={newForm.dueDate}
                onChange={(e) => setNewForm((f) => ({ ...f, dueDate: e.target.value }))}
                className="h-9 w-auto"
              />
            </div>
            <Input
              placeholder="Issue title…"
              value={newForm.title}
              onChange={(e) => setNewForm((f) => ({ ...f, title: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) void handleCreate(); }}
            />
            <Textarea
              placeholder="Description (optional)"
              value={newForm.description}
              onChange={(e) => setNewForm((f) => ({ ...f, description: e.target.value }))}
              rows={2}
            />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                disabled={creating || !newForm.title.trim() || !newForm.teamId}
                onClick={() => void handleCreate()}
                className="bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)] hover:bg-[oklch(0.78_0.12_85)]"
              >
                {creating ? "Creating…" : "Create"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => { setShowNewForm(false); setNewForm(EMPTY_NEW_ISSUE); }}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Filter bar */}
      <div className="flex flex-wrap gap-2 items-center">
        {/* Team selector */}
        <div className="relative">
          <select
            value={teamFilter}
            onChange={(e) => setTeamFilter(e.target.value)}
            className="h-9 rounded-md border border-border bg-background pl-3 pr-8 text-sm appearance-none"
          >
            <option value="all">All teams</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        </div>

        {/* Status filter */}
        <div className="relative">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilterValue)}
            className="h-9 rounded-md border border-border bg-background pl-3 pr-8 text-sm appearance-none"
          >
            {STATUS_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        </div>

        {/* Assigned to me toggle */}
        <button
          onClick={() => setAssigneeIsMe((v) => !v)}
          className={cn(
            "h-9 rounded-md border px-3 text-sm font-medium transition-colors",
            assigneeIsMe
              ? "border-[oklch(0.72_0.15_85)]/40 bg-[oklch(0.72_0.15_85)]/10 text-[oklch(0.55_0.15_85)]"
              : "border-border bg-background text-muted-foreground hover:text-foreground"
          )}
        >
          Assigned to me
        </button>

        {/* Issue count */}
        {!loading && (
          <span className="ml-auto text-xs text-muted-foreground">
            {issues.length} {issues.length === 1 ? "issue" : "issues"}
          </span>
        )}
      </div>

      {/* Main content area */}
      <div className={cn("flex gap-5 items-start", selectedIssue && "lg:pr-0")}>
        {/* Issue list */}
        <div className="flex-1 min-w-0 space-y-2">
          {loading ? (
            <SkeletonCards />
          ) : issues.length === 0 ? (
            <Card className="rounded-lg border border-border/60">
              <CardContent className="py-12 text-center space-y-2">
                <Triangle className="h-8 w-8 mx-auto text-muted-foreground/20" />
                <p className="text-sm text-muted-foreground">No issues match these filters</p>
              </CardContent>
            </Card>
          ) : (
            issues.map((issue) => (
              <IssueCard
                key={issue.id}
                issue={issue}
                onSelect={openPanel}
                selected={selectedIssue?.id === issue.id}
              />
            ))
          )}
        </div>

        {/* Detail / edit panel — slides in from right */}
        {selectedIssue && (
          <div
            className={cn(
              "w-full lg:w-[400px] shrink-0 rounded-lg border border-border/60 bg-background shadow-sm",
              "animate-in slide-in-from-right-4 duration-200",
              // On mobile, overlay the list
              "fixed inset-y-0 right-0 z-40 lg:static lg:z-auto overflow-y-auto",
              "max-h-screen lg:max-h-none"
            )}
          >
            <div className="p-5 space-y-4">
              {/* Panel header */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">
                    {selectedIssue.identifier}
                  </span>
                  <a
                    href={selectedIssue.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground/60 hover:text-[oklch(0.72_0.15_85)] transition-colors"
                    title="Open in Linear"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </div>
                <button
                  onClick={closePanel}
                  className="text-muted-foreground/50 hover:text-muted-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Title — click to edit inline */}
              {editingTitle ? (
                <Input
                  autoFocus
                  value={editForm.title}
                  onChange={(e) => setEditForm((f) => ({ ...f, title: e.target.value }))}
                  onBlur={() => setEditingTitle(false)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") setEditingTitle(false);
                    if (e.key === "Escape") {
                      setEditForm((f) => ({ ...f, title: selectedIssue.title }));
                      setEditingTitle(false);
                    }
                  }}
                  className="text-sm font-medium"
                />
              ) : (
                <button
                  className="w-full text-left text-sm font-medium leading-snug hover:text-[oklch(0.72_0.15_85)] transition-colors group flex items-start gap-1"
                  onClick={() => setEditingTitle(true)}
                  title="Click to edit title"
                >
                  <span className="flex-1">{editForm.title || selectedIssue.title}</span>
                  <Pencil className="h-3 w-3 text-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 mt-0.5" />
                </button>
              )}

              {/* Description */}
              <div className="space-y-1">
                <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Description
                </label>
                <Textarea
                  placeholder="Add a description…"
                  value={editForm.description}
                  onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
                  rows={3}
                  className="text-sm resize-none"
                />
              </div>

              {/* Status */}
              <div className="space-y-1">
                <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Status
                </label>
                <div className="relative">
                  <select
                    value={editForm.stateId}
                    onChange={(e) => setEditForm((f) => ({ ...f, stateId: e.target.value }))}
                    className="w-full h-9 rounded-md border border-border bg-background pl-3 pr-8 text-sm appearance-none"
                  >
                    {panelStates.length === 0 && (
                      <option value="">{selectedIssue.state.name}</option>
                    )}
                    {panelStates.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                </div>
              </div>

              {/* Priority */}
              <div className="space-y-1">
                <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Priority
                </label>
                <div className="flex gap-1.5 flex-wrap">
                  {Object.entries(PRIORITY_LABELS).map(([val, label]) => {
                    const num = Number(val);
                    const active = editForm.priority === num;
                    return (
                      <button
                        key={val}
                        onClick={() => setEditForm((f) => ({ ...f, priority: num }))}
                        className={cn(
                          "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                          active
                            ? "border-[oklch(0.72_0.15_85)]/40 bg-[oklch(0.72_0.15_85)]/10 text-foreground"
                            : "border-border text-muted-foreground hover:text-foreground hover:border-border/80"
                        )}
                      >
                        <PriorityDot priority={num} />
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Due date */}
              <div className="space-y-1">
                <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Due Date
                </label>
                <Input
                  type="date"
                  value={editForm.dueDate}
                  onChange={(e) => setEditForm((f) => ({ ...f, dueDate: e.target.value }))}
                  className="h-9 text-sm"
                />
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 pt-1">
                <Button
                  size="sm"
                  disabled={saving}
                  onClick={() => void handleSave()}
                  className="bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)] hover:bg-[oklch(0.78_0.12_85)]"
                >
                  {saving ? "Saving…" : "Save"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={closePanel}
                >
                  Cancel
                </Button>
                <a
                  href={selectedIssue.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ExternalLink className="h-3 w-3" />
                  Open in Linear
                </a>
              </div>

              {/* Assignee / meta */}
              {(selectedIssue.assignee || selectedIssue.project) && (
                <div className="pt-2 border-t border-border/50 space-y-1.5">
                  {selectedIssue.assignee && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-medium">Assignee:</span>
                      <span>{selectedIssue.assignee.name}</span>
                    </div>
                  )}
                  {selectedIssue.project && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-medium">Project:</span>
                      <span>{selectedIssue.project.name}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
