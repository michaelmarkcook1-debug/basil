"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
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
  MessageSquare,
  Send,
  Inbox,
  Trash2,
  Forward,
  Check,
  CheckCheck,
  Bell,
  Search,
  User,
  Tag,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { LinearIssue, LinearTeam, LinearWorkflowState, LinearComment, LinearNotification, LinearUser, LinearLabel } from "@/lib/linear/client";

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
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium", cls)}>
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
  /** Empty string = unassigned. */
  assigneeId: string;
  labelIds: string[];
}

const EMPTY_NEW_ISSUE: NewIssueForm = {
  teamId: "",
  title: "",
  description: "",
  stateId: "",
  priority: 0,
  dueDate: "",
  assigneeId: "",
  labelIds: [],
};

// ── Edit panel state ───────────────────────────────────────────────────────

interface EditForm {
  title: string;
  description: string;
  stateId: string;
  priority: number;
  dueDate: string;
  /** Empty string = unassigned. */
  assigneeId: string;
  /** Selected label IDs. */
  labelIds: string[];
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
  // "Done" = completed or cancelled. These are no longer actionable, so we
  // visually recede them: dim the whole card, strike the title, drop the
  // priority dot. Only NOT-done issues stay at full contrast so the feed
  // flags exactly what still needs attention.
  const isDone = issue.state.type === "completed" || issue.state.type === "cancelled";

  return (
    <Card
      className={cn(
        "rounded-lg border border-border/60 cursor-pointer transition-all hover:border-border group",
        selected && "border-[oklch(0.72_0.15_85)]/40 bg-[oklch(0.72_0.15_85)]/[0.03]",
        isDone && "opacity-55 hover:opacity-80"
      )}
      onClick={() => onSelect(issue)}
    >
      <CardContent className="p-3 flex items-center gap-3">
        {/* Priority dot — hidden for done issues (priority is moot once closed) */}
        {isDone ? (
          <span className="h-2.5 w-2.5 shrink-0" />
        ) : (
          <PriorityDot priority={issue.priority} className="shrink-0" />
        )}

        {/* Identifier */}
        <span className="font-mono text-xs text-muted-foreground shrink-0 min-w-[52px]">
          {issue.identifier}
        </span>

        {/* Title — struck through when done */}
        <span
          className={cn(
            "flex-1 text-sm truncate leading-snug",
            isDone ? "text-muted-foreground line-through" : "text-foreground"
          )}
        >
          {issue.title}
        </span>

        {/* Label dots — visible at-a-glance label colours, capped at 3 */}
        {issue.labels?.nodes && issue.labels.nodes.length > 0 && (
          <div className="hidden sm:flex items-center gap-0.5 shrink-0">
            {issue.labels.nodes.slice(0, 3).map((l) => (
              <span
                key={l.id}
                title={l.name}
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: l.color }}
              />
            ))}
          </div>
        )}

        {/* Right side */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Assignee initial — quick visual signal of who owns the issue */}
          {issue.assignee && (
            <span
              title={`Assigned to ${issue.assignee.name}`}
              className="hidden sm:inline-flex h-5 w-5 items-center justify-center rounded-full bg-[oklch(0.72_0.15_85)]/15 text-[10px] font-semibold text-[oklch(0.55_0.12_85)]"
            >
              {issue.assignee.name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase()}
            </span>
          )}
          {issue.dueDate && (
            <span className="hidden sm:flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              {issue.dueDate}
            </span>
          )}
          <span className="hidden md:block text-xs text-muted-foreground">
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

// ── Notification type label ────────────────────────────────────────────────

function notifLabel(type: string): string {
  const map: Record<string, string> = {
    issueAssignedToYou: "Assigned to you",
    issueCreated: "Issue created",
    issueUnassignedFromYou: "Unassigned",
    issueStatusChanged: "Status changed",
    issuePriorityChanged: "Priority changed",
    issueNewComment: "New comment",
    issueMentioned: "Mentioned",
    issueSubscribed: "Subscribed",
    issueDue: "Due soon",
    issueOverdue: "Overdue",
  };
  return map[type] ?? type.replace(/([A-Z])/g, " $1").trim();
}

// ── Inbox notification card ────────────────────────────────────────────────

function NotificationCard({
  notif,
  onReply,
  onDelete,
  onForward,
  onMarkRead,
}: {
  notif: LinearNotification;
  onReply: (notif: LinearNotification) => void;
  onDelete: (id: string) => void;
  onForward: (notif: LinearNotification) => void;
  onMarkRead: (id: string) => void;
}) {
  const isRead = !!notif.readAt;
  const timeAgo = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  };

  return (
    <Card
      className={cn(
        "rounded-lg border transition-all",
        isRead
          ? "border-border/40 bg-background/50"
          : "border-[oklch(0.72_0.15_85)]/25 bg-[oklch(0.72_0.15_85)]/[0.03]"
      )}
    >
      <CardContent className="p-3 space-y-2">
        {/* Top row */}
        <div className="flex items-start gap-2">
          {/* Unread dot */}
          <span
            className={cn(
              "mt-1.5 h-1.5 w-1.5 rounded-full shrink-0",
              isRead ? "bg-transparent" : "bg-[oklch(0.72_0.15_85)]"
            )}
          />
          <div className="flex-1 min-w-0 space-y-0.5">
            {/* Type badge + time */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                {notifLabel(notif.type)}
              </span>
              {notif.actor && (
                <span className="text-xs text-muted-foreground/60">
                  by {notif.actor.name}
                </span>
              )}
              <span className="ml-auto text-xs text-muted-foreground/50 shrink-0">
                {timeAgo(notif.createdAt)}
              </span>
            </div>
            {/* Issue title */}
            {notif.issue && (
              <a
                href={notif.issue.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block text-sm font-medium text-foreground hover:text-[oklch(0.72_0.15_85)] transition-colors truncate"
              >
                <span className="font-mono text-xs text-muted-foreground mr-1.5">
                  {notif.issue.identifier}
                </span>
                {notif.issue.title}
              </a>
            )}
            {/* Comment preview */}
            {notif.comment?.body && (
              <p className="text-xs text-muted-foreground/80 line-clamp-2 leading-relaxed">
                {notif.comment.body}
              </p>
            )}
          </div>
        </div>

        {/* Action row */}
        <div className="flex items-center gap-1 pl-3.5">
          {/* Reply — only if there's an issue to reply to */}
          {notif.issue && (
            <button
              onClick={() => onReply(notif)}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground/70 hover:text-foreground hover:bg-accent/40 transition-colors"
              title="Reply"
            >
              <MessageSquare className="h-3 w-3" />
              Reply
            </button>
          )}
          {/* Forward — copy to clipboard */}
          {notif.issue && (
            <button
              onClick={() => onForward(notif)}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground/70 hover:text-foreground hover:bg-accent/40 transition-colors"
              title="Copy link"
            >
              <Forward className="h-3 w-3" />
              Forward
            </button>
          )}
          {/* Mark read */}
          {!isRead && (
            <button
              onClick={() => onMarkRead(notif.id)}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground/70 hover:text-foreground hover:bg-accent/40 transition-colors"
              title="Mark as read"
            >
              <Check className="h-3 w-3" />
              Mark read
            </button>
          )}
          {/* Delete / archive */}
          <button
            onClick={() => onDelete(notif.id)}
            className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground/50 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/20 transition-colors"
            title="Archive notification"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Reply panel for inbox ──────────────────────────────────────────────────

function InboxReplyPanel({
  notif,
  onClose,
  onSent,
}: {
  notif: LinearNotification;
  onClose: () => void;
  onSent: (notifId: string) => void;
}) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  async function send() {
    if (!notif.issue || !body.trim()) return;
    setSending(true);
    try {
      const res = await fetch(`/api/linear/issues/${notif.issue.id}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: body.trim() }),
      });
      if (res.ok) {
        onSent(notif.id);
        onClose();
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <Card className="rounded-lg border border-[oklch(0.72_0.15_85)]/30 bg-[oklch(0.72_0.15_85)]/[0.02]">
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-muted-foreground">
            Replying to{" "}
            <span className="font-mono text-xs">{notif.issue?.identifier}</span>
          </p>
          <button onClick={onClose} className="text-muted-foreground/50 hover:text-muted-foreground">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        {notif.comment?.body && (
          <blockquote className="border-l-2 border-[oklch(0.72_0.15_85)]/40 pl-2 text-xs text-muted-foreground/70 line-clamp-2">
            {notif.comment.body}
          </blockquote>
        )}
        <div className="flex gap-2 items-end">
          <Textarea
            autoFocus
            placeholder="Write a reply…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send();
              }
            }}
            rows={2}
            className="text-xs resize-none flex-1"
          />
          <button
            disabled={sending || !body.trim()}
            onClick={() => void send()}
            className={cn(
              "h-9 w-9 rounded-md border flex items-center justify-center shrink-0 transition-colors",
              body.trim()
                ? "border-[oklch(0.72_0.15_85)]/40 bg-[oklch(0.72_0.15_85)]/10 text-[oklch(0.55_0.15_85)] hover:bg-[oklch(0.72_0.15_85)]/20"
                : "border-border text-muted-foreground/40"
            )}
            title="Send (⌘↵)"
          >
            <Send className={cn("h-3.5 w-3.5", sending && "opacity-40")} />
          </button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Forward toast ──────────────────────────────────────────────────────────

function ForwardToast({ visible }: { visible: boolean }) {
  return (
    <div
      className={cn(
        "fixed bottom-24 left-1/2 -translate-x-1/2 z-50 rounded-lg bg-foreground text-background text-xs px-3 py-2 shadow-lg transition-all duration-300",
        visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2 pointer-events-none"
      )}
    >
      Link copied to clipboard
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

  // Tab: "issues" | "inbox"
  const [activeTab, setActiveTab] = useState<"issues" | "inbox">("issues");

  // Inbox
  const [notifications, setNotifications] = useState<LinearNotification[]>([]);
  const [inboxLoading, setInboxLoading] = useState(false);
  const [replyingTo, setReplyingTo] = useState<LinearNotification | null>(null);
  const [forwardToastVisible, setForwardToastVisible] = useState(false);

  // Filters
  const [teamFilter, setTeamFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>("all");
  // Default to the broad workspace view — defaulting to "assigned to me"
  // hid important issues from other teams (tickets where the user is mentioned,
  // active blockers on adjacent work, etc.). The "Assigned to me" toggle is
  // still one click away when the user wants the personal-queue view.
  const [assigneeIsMe, setAssigneeIsMe] = useState(false);
  // Free-text search over the issue list — applied client-side after fetch.
  const [search, setSearch] = useState("");

  // Workspace members + labels — loaded once and reused by both forms.
  const [workspaceUsers, setWorkspaceUsers] = useState<LinearUser[]>([]);
  const [labels, setLabels] = useState<LinearLabel[]>([]);

  // Detail/edit panel
  const [selectedIssue, setSelectedIssue] = useState<LinearIssue | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({
    title: "",
    description: "",
    stateId: "",
    priority: 0,
    dueDate: "",
    assigneeId: "",
    labelIds: [],
  });
  const [saving, setSaving] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);

  // New issue form
  const [showNewForm, setShowNewForm] = useState(false);
  const [newForm, setNewForm] = useState<NewIssueForm>(EMPTY_NEW_ISSUE);
  const [creating, setCreating] = useState(false);

  // Panel states for team-specific workflow states
  const [panelStates, setPanelStates] = useState<LinearWorkflowState[]>([]);

  // Comments
  const [comments, setComments] = useState<LinearComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const [sendingReply, setSendingReply] = useState(false);

  // Load teams on mount
  useEffect(() => {
    fetch("/api/linear/teams")
      .then(async (res) => {
        if (res.status === 503) { setNotConnected(true); return; }
        if (!res.ok) return;
        const data = (await res.json()) as { teams: LinearTeam[] };
        setTeams(data.teams);
      })
      .catch((err) => { console.warn("[linear] background load failed:", err); });
  }, []);

  // Load workflow states (all) on mount
  useEffect(() => {
    fetch("/api/linear/states")
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { states: LinearWorkflowState[] };
        setStates(data.states);
      })
      .catch((err) => { console.warn("[linear] background load failed:", err); });
  }, []);

  // Load workspace members for the assignee picker.
  useEffect(() => {
    fetch("/api/linear/users")
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { users: LinearUser[] };
        setWorkspaceUsers(data.users || []);
      })
      .catch((err) => { console.warn("[linear] background load failed:", err); });
  }, []);

  // Load labels (all teams) once — filtered in the UI per team when needed.
  useEffect(() => {
    fetch("/api/linear/labels")
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { labels: LinearLabel[] };
        setLabels(data.labels || []);
      })
      .catch((err) => { console.warn("[linear] background load failed:", err); });
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

  async function loadComments(issueId: string) {
    setCommentsLoading(true);
    try {
      const res = await fetch(`/api/linear/issues/${issueId}/comments`);
      if (res.ok) {
        const data = (await res.json()) as { comments: LinearComment[] };
        setComments(data.comments);
      }
    } catch {
      // silent
    } finally {
      setCommentsLoading(false);
    }
  }

  function openPanel(issue: LinearIssue) {
    setSelectedIssue(issue);
    const currentState = states.find((s) => s.name === issue.state.name);
    setEditForm({
      title: issue.title,
      description: issue.description ?? "",
      stateId: currentState?.id ?? "",
      priority: issue.priority,
      dueDate: issue.dueDate ?? "",
      assigneeId: issue.assignee?.id ?? "",
      labelIds: (issue.labels?.nodes ?? []).map((l) => l.id),
    });
    setEditingTitle(false);
    setComments([]);
    setReplyBody("");
    void loadComments(issue.id);
  }

  function closePanel() {
    setSelectedIssue(null);
    setEditingTitle(false);
    setComments([]);
    setReplyBody("");
  }

  async function handleSendReply() {
    if (!selectedIssue || !replyBody.trim()) return;
    setSendingReply(true);
    try {
      const res = await fetch(`/api/linear/issues/${selectedIssue.id}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: replyBody.trim() }),
      });
      if (res.ok) {
        const data = (await res.json()) as { comment: LinearComment };
        setComments((prev) => [...prev, data.comment]);
        setReplyBody("");
      }
    } catch {
      // silent
    } finally {
      setSendingReply(false);
    }
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
        // Assignee: empty string = explicitly unassign (Linear accepts null).
        assigneeId: editForm.assigneeId || null,
        // Labels: empty array clears all labels.
        labelIds: editForm.labelIds,
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
      if (newForm.assigneeId) body.assigneeId = newForm.assigneeId;
      if (newForm.labelIds.length > 0) body.labelIds = newForm.labelIds;

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
    if (activeTab === "inbox") {
      await loadNotifications();
    } else {
      await loadIssues();
    }
    setRefreshing(false);
  }

  // ── Inbox handlers ───────────────────────────────────────────────────────

  async function loadNotifications() {
    setInboxLoading(true);
    try {
      const res = await fetch("/api/linear/notifications");
      if (res.ok) {
        const data = (await res.json()) as { notifications: LinearNotification[] };
        setNotifications(data.notifications);
      }
    } catch { /* silent */ } finally {
      setInboxLoading(false);
    }
  }

  useEffect(() => {
    if (activeTab === "inbox" && notifications.length === 0) {
      void loadNotifications();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  async function handleDeleteNotif(id: string) {
    // Optimistic remove
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    try {
      await fetch(`/api/linear/notifications/${id}`, { method: "DELETE" });
    } catch { /* silent */ }
  }

  async function handleMarkRead(id: string) {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n))
    );
    try {
      await fetch(`/api/linear/notifications/${id}`, { method: "PATCH" });
    } catch { /* silent */ }
  }

  async function handleMarkAllRead() {
    setNotifications((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
    try {
      await fetch("/api/linear/notifications", { method: "PATCH" });
    } catch { /* silent */ }
  }

  function handleForward(notif: LinearNotification) {
    if (!notif.issue) return;
    const text = `${notif.issue.identifier}: ${notif.issue.title}\n${notif.issue.url}`;
    void navigator.clipboard.writeText(text).then(() => {
      setForwardToastVisible(true);
      setTimeout(() => setForwardToastVisible(false), 2500);
    });
  }

  // New form team-specific states
  const newFormStates = newForm.teamId
    ? states.filter((s) => s.team.id === newForm.teamId)
    : states;

  // ── HOOKS MUST RUN UNCONDITIONALLY ─────────────────────────────────────────
  // Compute filteredIssues before the early-return below — otherwise the hook
  // order changes when notConnected flips and React throws "rendered fewer
  // hooks than expected". `unreadCount` doesn't need a hook so it stays where
  // it makes sense (after the early return).
  const filteredIssues = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matched = !q
      ? issues
      : issues.filter((i) =>
          i.identifier.toLowerCase().includes(q) ||
          i.title.toLowerCase().includes(q) ||
          i.team.name.toLowerCase().includes(q) ||
          (i.assignee?.name ?? "").toLowerCase().includes(q)
        );
    // Sink "done" (completed/cancelled) issues to the bottom so the feed leads
    // with what still needs action. Stable within each group (preserves the
    // server's priority ordering).
    const isDone = (i: LinearIssue) =>
      i.state.type === "completed" || i.state.type === "cancelled";
    return [...matched].sort((a, b) => Number(isDone(a)) - Number(isDone(b)));
  }, [issues, search]);

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

  const unreadCount = notifications.filter((n) => !n.readAt).length;

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-5">
      {/* Forward toast */}
      <ForwardToast visible={forwardToastVisible} />

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
          {activeTab === "issues" && (
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
          )}
        </div>
      </header>

      {/* Tab switcher */}
      <div className="flex items-center gap-1 border-b border-border/50">
        <button
          onClick={() => setActiveTab("issues")}
          className={cn(
            "flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors -mb-px",
            activeTab === "issues"
              ? "border-[oklch(0.72_0.15_85)] text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          <Triangle className="h-3.5 w-3.5" />
          Issues
        </button>
        <button
          onClick={() => setActiveTab("inbox")}
          className={cn(
            "flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors -mb-px",
            activeTab === "inbox"
              ? "border-[oklch(0.72_0.15_85)] text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          <div className="relative">
            <Bell className="h-3.5 w-3.5" />
            {unreadCount > 0 && (
              <span className="absolute -top-1 -right-1.5 h-3.5 w-3.5 rounded-full bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)] text-[8px] font-bold flex items-center justify-center">
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            )}
          </div>
          Inbox
        </button>
      </div>

      {/* ── INBOX TAB ─────────────────────────────────────────────────── */}
      {activeTab === "inbox" && (
        <div className="space-y-3">
          {/* Inbox toolbar */}
          <div className="flex items-center gap-2">
            {unreadCount > 0 && (
              <button
                onClick={() => void handleMarkAllRead()}
                className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:border-border/80 transition-colors"
              >
                <CheckCheck className="h-3.5 w-3.5" />
                Mark all read
              </button>
            )}
            <span className="ml-auto text-xs text-muted-foreground">
              {notifications.length === 0
                ? ""
                : `${unreadCount} unread · ${notifications.length} total`}
            </span>
          </div>

          {/* Reply panel */}
          {replyingTo && (
            <InboxReplyPanel
              notif={replyingTo}
              onClose={() => setReplyingTo(null)}
              onSent={(id) => handleMarkRead(id)}
            />
          )}

          {/* Notification list */}
          {inboxLoading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4].map((i) => (
                <Card key={i} className="rounded-lg border border-border/60">
                  <CardContent className="p-3 space-y-2">
                    <Skeleton className="h-3 w-32" />
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-3 w-2/3" />
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : notifications.length === 0 ? (
            <Card className="rounded-lg border border-border/60">
              <CardContent className="py-12 text-center space-y-2">
                <Inbox className="h-8 w-8 mx-auto text-muted-foreground/20" />
                <p className="text-sm text-muted-foreground">Inbox is empty</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {notifications.map((notif) => (
                <NotificationCard
                  key={notif.id}
                  notif={notif}
                  onReply={(n) => setReplyingTo(replyingTo?.id === n.id ? null : n)}
                  onDelete={handleDeleteNotif}
                  onForward={handleForward}
                  onMarkRead={handleMarkRead}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── ISSUES TAB ────────────────────────────────────────────────── */}
      {activeTab === "issues" && <>

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
              <select
                value={newForm.assigneeId}
                onChange={(e) => setNewForm((f) => ({ ...f, assigneeId: e.target.value }))}
                className="h-9 rounded-md border border-border bg-background px-3 text-sm"
              >
                <option value="">Unassigned</option>
                {workspaceUsers.map((u) => (
                  <option key={u.id} value={u.id}>{u.displayName ?? u.name}</option>
                ))}
              </select>
            </div>

            {/* Label picker — only when a team is selected (labels are team-scoped) */}
            {newForm.teamId && labels.filter((l) => !l.team?.id || l.team.id === newForm.teamId).length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                <span className="text-xs text-muted-foreground self-center mr-1">Labels:</span>
                {labels
                  .filter((l) => !l.team?.id || l.team.id === newForm.teamId)
                  .map((label) => {
                    const active = newForm.labelIds.includes(label.id);
                    return (
                      <button
                        key={label.id}
                        type="button"
                        onClick={() =>
                          setNewForm((f) => ({
                            ...f,
                            labelIds: active
                              ? f.labelIds.filter((id) => id !== label.id)
                              : [...f.labelIds, label.id],
                          }))
                        }
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors",
                          active
                            ? "bg-foreground/5 border-foreground/30"
                            : "border-border text-muted-foreground hover:text-foreground hover:border-border/80"
                        )}
                        style={active ? { borderColor: label.color, color: label.color } : undefined}
                      >
                        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: label.color }} />
                        {label.name}
                      </button>
                    );
                  })}
              </div>
            )}

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

      {/* Search bar */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/60" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search issues by title, identifier, team, or assignee…"
          className="w-full h-10 rounded-md border border-border bg-background pl-10 pr-3 text-sm outline-none focus:ring-2 focus:ring-[oklch(0.72_0.15_85)]/40"
        />
        {search && (
          <button
            onClick={() => setSearch("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1"
            title="Clear search"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

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

        {/* "Assigned to me" — filters the broad workspace view down to the
            user's personal queue. Off by default so the feed shows what's
            important across all teams (mentions, blockers on adjacent work). */}
        <button
          onClick={() => setAssigneeIsMe((v) => !v)}
          title={assigneeIsMe ? "Showing only your assigned issues — click to see all teams" : "Filter down to just your assigned issues"}
          className={cn(
            "h-9 rounded-md border px-3 text-sm font-medium transition-colors",
            assigneeIsMe
              ? "border-[oklch(0.72_0.15_85)]/40 bg-[oklch(0.72_0.15_85)]/10 text-[oklch(0.55_0.15_85)]"
              : "border-border bg-background text-muted-foreground hover:text-foreground"
          )}
        >
          {assigneeIsMe ? "Showing: mine" : "Only mine"}
        </button>

        {/* Issue count */}
        {!loading && (
          <span className="ml-auto text-xs text-muted-foreground">
            {filteredIssues.length} {filteredIssues.length === 1 ? "issue" : "issues"}
            {search && issues.length !== filteredIssues.length && (
              <span className="text-muted-foreground/70"> · of {issues.length}</span>
            )}
          </span>
        )}
      </div>

      {/* Main content area */}
      <div className={cn("flex gap-5 items-start", selectedIssue && "lg:pr-0")}>
        {/* Issue list */}
        <div className="flex-1 min-w-0 space-y-2">
          {loading ? (
            <SkeletonCards />
          ) : filteredIssues.length === 0 ? (
            <Card className="rounded-lg border border-border/60">
              <CardContent className="py-12 text-center space-y-2">
                <Triangle className="h-8 w-8 mx-auto text-muted-foreground/20" />
                <p className="text-sm text-muted-foreground">
                  {search ? `No issues match "${search}"` : "No issues match these filters"}
                </p>
                {search && (
                  <button
                    onClick={() => setSearch("")}
                    className="text-xs text-[oklch(0.55_0.12_85)] hover:underline"
                  >
                    Clear search
                  </button>
                )}
              </CardContent>
            </Card>
          ) : (
            filteredIssues.map((issue) => (
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
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
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
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
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
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
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

              {/* Assignee */}
              <div className="space-y-1">
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                  <User className="h-3 w-3" />
                  Assignee
                </label>
                <div className="relative">
                  <select
                    value={editForm.assigneeId}
                    onChange={(e) => setEditForm((f) => ({ ...f, assigneeId: e.target.value }))}
                    className="w-full h-9 rounded-md border border-border bg-background pl-3 pr-8 text-sm appearance-none"
                  >
                    <option value="">Unassigned</option>
                    {workspaceUsers.map((u) => (
                      <option key={u.id} value={u.id}>{u.displayName ?? u.name}</option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                </div>
              </div>

              {/* Labels — multi-select pill toggles */}
              <div className="space-y-1">
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                  <Tag className="h-3 w-3" />
                  Labels
                </label>
                <div className="flex gap-1.5 flex-wrap">
                  {labels
                    // Show workspace-wide labels + labels belonging to this issue's team.
                    .filter((l) => !l.team?.id || l.team.id === selectedIssue.team.id)
                    .map((label) => {
                      const active = editForm.labelIds.includes(label.id);
                      return (
                        <button
                          key={label.id}
                          onClick={() =>
                            setEditForm((f) => ({
                              ...f,
                              labelIds: active
                                ? f.labelIds.filter((id) => id !== label.id)
                                : [...f.labelIds, label.id],
                            }))
                          }
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
                            active
                              ? "bg-foreground/5 border-foreground/30 text-foreground"
                              : "border-border text-muted-foreground hover:text-foreground hover:border-border/80"
                          )}
                          style={active ? { borderColor: label.color, color: label.color } : undefined}
                        >
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: label.color }}
                          />
                          {label.name}
                        </button>
                      );
                    })}
                  {labels.length === 0 && (
                    <span className="text-xs text-muted-foreground italic">No labels available</span>
                  )}
                </div>
              </div>

              {/* Due date */}
              <div className="space-y-1">
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
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

              {/* Comments section */}
              <div className="pt-3 border-t border-border/50 space-y-3">
                <div className="flex items-center gap-2">
                  <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
                  <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Comments
                    {comments.length > 0 && (
                      <span className="ml-1.5 text-muted-foreground/60 normal-case font-normal">
                        ({comments.length})
                      </span>
                    )}
                  </label>
                </div>

                {/* Comment thread */}
                {commentsLoading ? (
                  <div className="space-y-3">
                    {[1, 2].map((i) => (
                      <div key={i} className="space-y-1.5">
                        <Skeleton className="h-3 w-24" />
                        <Skeleton className="h-8 w-full" />
                      </div>
                    ))}
                  </div>
                ) : comments.length === 0 ? (
                  <p className="text-xs text-muted-foreground/60 py-1">No comments yet.</p>
                ) : (
                  <div className="space-y-3 max-h-64 overflow-y-auto pr-1">
                    {comments.map((c) => (
                      <div key={c.id} className="space-y-1">
                        <div className="flex items-center gap-2">
                          {/* Avatar initial */}
                          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[oklch(0.72_0.15_85)]/15 text-xs font-semibold text-[oklch(0.55_0.15_85)] shrink-0">
                            {c.user.name.charAt(0).toUpperCase()}
                          </span>
                          <span className="text-xs font-medium text-foreground">{c.user.name}</span>
                          <span className="text-xs text-muted-foreground/60 ml-auto shrink-0">
                            {new Date(c.createdAt).toLocaleDateString(undefined, {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                        </div>
                        <div className="ml-7 text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">
                          {c.body}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Reply input */}
                <div className="flex gap-2 items-end">
                  <Textarea
                    placeholder="Write a comment…"
                    value={replyBody}
                    onChange={(e) => setReplyBody(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        void handleSendReply();
                      }
                    }}
                    rows={2}
                    className="text-xs resize-none flex-1"
                  />
                  <button
                    disabled={sendingReply || !replyBody.trim()}
                    onClick={() => void handleSendReply()}
                    className={cn(
                      "h-9 w-9 rounded-md border flex items-center justify-center shrink-0 transition-colors",
                      replyBody.trim()
                        ? "border-[oklch(0.72_0.15_85)]/40 bg-[oklch(0.72_0.15_85)]/10 text-[oklch(0.55_0.15_85)] hover:bg-[oklch(0.72_0.15_85)]/20"
                        : "border-border text-muted-foreground/40"
                    )}
                    title="Send comment (⌘↵)"
                  >
                    <Send className={cn("h-3.5 w-3.5", sendingReply && "opacity-40")} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      </> /* end issues tab */}
    </div>
  );
}
