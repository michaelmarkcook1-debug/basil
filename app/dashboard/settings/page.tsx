"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Settings,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  Calendar,
  Mail,
  FileText,
  Hash,
  Bot,
  RefreshCw,
  Pencil,
  Check,
  X,
  Database,
  Building2,
  Video,
  MessageSquare,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import type { IntegrationStatus, IntegrationState } from "@/lib/integrations/types";

// ── Status badge ─────────────────────────────────────────────────────────────

function StateBadge({ state }: { state: IntegrationState | "loading" }) {
  if (state === "loading") {
    return (
      <Badge variant="secondary" className="gap-1 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Checking
      </Badge>
    );
  }
  if (state === "connected") {
    return (
      <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 gap-1 text-xs">
        <CheckCircle2 className="h-3 w-3" />
        Connected
      </Badge>
    );
  }
  if (state === "permission_missing") {
    return (
      <Badge className="bg-amber-100 text-amber-700 border-amber-200 gap-1 text-xs">
        <AlertTriangle className="h-3 w-3" />
        Permission missing
      </Badge>
    );
  }
  if (state === "token_expired") {
    return (
      <Badge className="bg-amber-100 text-amber-700 border-amber-200 gap-1 text-xs">
        <AlertTriangle className="h-3 w-3" />
        Token expired
      </Badge>
    );
  }
  if (state === "error") {
    return (
      <Badge className="bg-red-100 text-red-700 border-red-200 gap-1 text-xs">
        <XCircle className="h-3 w-3" />
        Error
      </Badge>
    );
  }
  // disconnected (default)
  return (
    <Badge variant="secondary" className="gap-1 text-xs text-muted-foreground">
      <XCircle className="h-3 w-3" />
      Not connected
    </Badge>
  );
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface AllStatuses {
  google:     IntegrationStatus;
  slack:      IntegrationStatus;
  microsoft?: IntegrationStatus & { microsoft?: { mail: boolean; calendar: boolean; drive: boolean; teams: boolean } };
  claude:     IntegrationStatus;
  snapshot?:  SnapshotDiagnostics;
}

interface SnapshotDiagnostics {
  isConfigured:      boolean;
  lastAttemptAt:     string | null;
  lastSuccessAt:     string | null;
  lastFailureAt:     string | null;
  lastFailureReason: string | null;
  payloadBytes:      number | null;
}

// Mirrors UserSettings from lib/settings/store.ts — all fields are strings.
interface UserSettings {
  name:       string;
  timezone:   string;
  workStart:  string;
  workEnd:    string;
  videoTool:  string;
  meetingUrl: string;
}

// ── Timezone validation ───────────────────────────────────────────────────────
// Uses the same Intl.DateTimeFormat approach as the server-side validator.
// Available in all modern browsers (Chrome 24+, Firefox 29+, Safari 10+).
function isValidTimezone(tz: string): boolean {
  if (!tz || !tz.trim()) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const [statuses, setStatuses]   = useState<AllStatuses | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [reprocessing, setReprocessing] = useState(false);
  const [reprocessResult, setReprocessResult] = useState<string | null>(null);

  // ── Profile/settings state ────────────────────────────────────────────────
  const [profile, setProfile]         = useState<UserSettings | null>(null);
  const [editing, setEditing]         = useState(false);
  const [draft, setDraft]             = useState<UserSettings | null>(null);
  const [saving, setSaving]           = useState(false);
  const [saveError, setSaveError]     = useState<string | null>(null);

  // Timezone validation is checked inline as the user types
  const timezoneInvalid =
    editing && draft?.timezone !== undefined && !isValidTimezone(draft.timezone);

  async function loadSettings() {
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setProfile(await res.json() as UserSettings);
    } catch {
      // Non-fatal — page still works, profile just shows nothing
    }
  }

  function startEdit() {
    if (!profile) return;
    setDraft({ ...profile });
    setSaveError(null);
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setDraft(null);
    setSaveError(null);
  }

  async function saveEdit() {
    if (!draft) return;
    // Block save if the timezone field is currently invalid
    if (timezoneInvalid) {
      setSaveError(`"${draft.timezone}" is not a valid IANA timezone. Use a format like "Europe/London" or "America/New_York".`);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/settings", {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(draft),
      });
      const data = await res.json() as UserSettings & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setProfile(data);
      setEditing(false);
      setDraft(null);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function loadStatuses() {
    setRefreshing(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/integrations/status", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as AllStatuses;
      setStatuses(data);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load integration status");
    } finally {
      setRefreshing(false);
    }
  }

  async function triggerReprocess() {
    setReprocessing(true);
    setReprocessResult(null);
    try {
      const res = await fetch("/api/events/reprocess", { method: "POST" });
      const data = await res.json() as { queued?: number; message?: string; error?: string };
      setReprocessResult(data.message ?? (res.ok ? "Done" : "Failed"));
    } catch {
      setReprocessResult("Request failed — check network.");
    } finally {
      setReprocessing(false);
    }
  }

  useEffect(() => {
    void loadStatuses();
    void loadSettings();
  }, []);

  const g  = statuses?.google;
  const ms = statuses?.microsoft;
  const googleConnected    = g?.state  === "connected" || g?.state  === "permission_missing";
  const microsoftConnected = ms?.state === "connected" || ms?.state === "permission_missing";

  const integrations: {
    key:         string;
    name:        string;
    icon:        typeof Calendar;
    description: string;
    color:       string;
    status:      IntegrationStatus | null;
    note?:       string;
    group:       "google" | "microsoft" | "other";
  }[] = [
    // ── Google Workspace ─────────────────────────────────────────────────────
    {
      key:         "calendar",
      name:        "Google Calendar",
      icon:        Calendar,
      description: "View and manage calendar events",
      color:       "text-[oklch(0.72_0.15_85)]",
      group:       "google",
      status:      g
        ? { ...g, state: g.google?.calendar ? "connected" : googleConnected ? "permission_missing" : g.state }
        : null,
    },
    {
      key:         "gmail",
      name:        "Gmail",
      icon:        Mail,
      description: "Read and draft emails",
      color:       "text-pink-500",
      group:       "google",
      status:      g
        ? { ...g, state: g.google?.gmail ? "connected" : googleConnected ? "permission_missing" : g.state }
        : null,
    },
    {
      key:         "drive",
      name:        "Google Drive",
      icon:        FileText,
      description: "Search and read documents",
      color:       "text-amber-500",
      group:       "google",
      status:      g
        ? { ...g, state: g.google?.drive ? "connected" : googleConnected ? "permission_missing" : g.state }
        : null,
    },
    // ── Microsoft 365 ────────────────────────────────────────────────────────
    {
      key:         "outlook_mail",
      name:        "Outlook Mail",
      icon:        Mail,
      description: "Read and send Outlook emails",
      color:       "text-blue-500",
      group:       "microsoft",
      status:      ms
        ? { ...ms, state: ms.microsoft?.mail ? "connected" : microsoftConnected ? "permission_missing" : ms.state }
        : null,
    },
    {
      key:         "outlook_calendar",
      name:        "Outlook Calendar",
      icon:        Calendar,
      description: "View and manage Outlook calendar events",
      color:       "text-sky-500",
      group:       "microsoft",
      status:      ms
        ? { ...ms, state: ms.microsoft?.calendar ? "connected" : microsoftConnected ? "permission_missing" : ms.state }
        : null,
    },
    {
      key:         "onedrive",
      name:        "OneDrive",
      icon:        FileText,
      description: "Search and read OneDrive files",
      color:       "text-indigo-500",
      group:       "microsoft",
      status:      ms
        ? { ...ms, state: ms.microsoft?.drive ? "connected" : microsoftConnected ? "permission_missing" : ms.state }
        : null,
    },
    {
      key:         "teams",
      name:        "Microsoft Teams",
      icon:        MessageSquare,
      description: "Read and send Teams messages",
      color:       "text-violet-500",
      group:       "microsoft",
      status:      ms
        ? { ...ms, state: ms.microsoft?.teams ? "connected" : microsoftConnected ? "permission_missing" : ms.state }
        : null,
    },
    // ── Other integrations ───────────────────────────────────────────────────
    {
      key:         "slack",
      name:        "Slack",
      icon:        Hash,
      description: "Read and send Slack messages",
      color:       "text-emerald-500",
      group:       "other",
      status:      statuses?.slack ?? null,
      note:        "Add SLACK_BOT_TOKEN and SLACK_USER_TOKEN to your environment variables to connect Slack.",
    },
    {
      key:         "zoom",
      name:        "Zoom",
      icon:        Video,
      description: "Meeting summaries ingested automatically from email",
      color:       "text-blue-400",
      group:       "other",
      status:      { id: "zoom", state: "connected", lastCheckedAt: new Date().toISOString() },
      note:        "Zoom summaries arrive via email — no separate auth required.",
    },
    {
      key:         "claude",
      name:        "AI Assistant (Claude)",
      icon:        Bot,
      description: "AI chat powered by Anthropic Claude",
      color:       "text-[oklch(0.58_0.15_85)]",
      group:       "other",
      status:      statuses?.claude ?? null,
      note:        "Configured via ANTHROPIC_API_KEY environment variable.",
    },
  ];

  const snap = statuses?.snapshot;

  return (
    <div className="p-6 lg:p-8 space-y-6 max-w-2xl pb-8">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Settings className="h-6 w-6 text-[oklch(0.72_0.15_85)]" />
            Settings
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage integrations and preferences.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={loadStatuses}
          disabled={refreshing}
          className="gap-1.5 text-xs text-muted-foreground shrink-0"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </header>

      {/* Load error banner */}
      {loadError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Could not load integration status: {loadError}
        </div>
      )}

      {/* ── Google connect / re-auth CTAs ─────────────────────────────────── */}
      {statuses && g?.state === "disconnected" && (
        <Card className="border-[oklch(0.72_0.15_85)]/30 bg-[oklch(0.72_0.15_85)]/5">
          <CardContent className="py-6 text-center space-y-3">
            <p className="font-medium">Connect Google to unlock Calendar, Gmail, and Drive</p>
            <p className="text-sm text-muted-foreground">
              One-time authorization — grants access to your calendar, emails, and documents.
            </p>
            <Button
              className="bg-[oklch(0.22_0.05_250)] hover:bg-[oklch(0.28_0.06_250)] text-white"
              onClick={() => { window.location.href = "/api/auth/google"; }}
            >
              Connect Google Account
            </Button>
          </CardContent>
        </Card>
      )}
      {statuses && g?.state === "permission_missing" && (
        <Card className="border-amber-400/30 bg-amber-500/5">
          <CardContent className="py-5 text-center space-y-3">
            <p className="font-medium text-amber-700">Some Google permissions are missing</p>
            <p className="text-sm text-muted-foreground">
              Re-authorize to grant Calendar, Gmail, and Drive access.
            </p>
            <Button
              className="bg-amber-600 hover:bg-amber-700 text-white"
              onClick={() => { window.location.href = "/api/auth/google"; }}
            >
              Re-authorize Google
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ── Microsoft 365 connect / re-auth CTAs ───────────────────────────── */}
      {/* Show connect for: never connected, disconnected, OR error state */}
      {statuses && (!ms || ms.state === "disconnected" || ms.state === "error") && (
        <Card className="border-blue-500/30 bg-blue-500/5">
          <CardContent className="py-6 text-center space-y-3">
            <div className="flex items-center justify-center gap-2">
              <Building2 className="h-5 w-5 text-blue-500" />
              <p className="font-medium">Connect Microsoft 365</p>
            </div>
            <p className="text-sm text-muted-foreground">
              Grants access to Outlook Mail, Outlook Calendar, OneDrive, and Teams — alongside or instead of Google.
            </p>
            {ms?.state === "error" && ms.error && (
              <p className="text-xs text-red-600 bg-red-50 rounded px-3 py-1.5">{ms.error}</p>
            )}
            <Button
              className="bg-blue-600 hover:bg-blue-700 text-white"
              onClick={() => { window.location.href = "/api/auth/microsoft"; }}
            >
              Connect Microsoft 365
            </Button>
          </CardContent>
        </Card>
      )}
      {statuses && (ms?.state === "permission_missing" || ms?.state === "token_expired") && (
        <Card className="border-amber-400/30 bg-amber-500/5">
          <CardContent className="py-5 text-center space-y-3">
            <p className="font-medium text-amber-700">
              {ms?.state === "token_expired"
                ? "Microsoft 365 session expired"
                : "Some Microsoft 365 permissions are missing"}
            </p>
            <p className="text-sm text-muted-foreground">
              Re-authorize to restore Outlook, OneDrive, and Teams access.
            </p>
            <Button
              className="bg-amber-600 hover:bg-amber-700 text-white"
              onClick={() => { window.location.href = "/api/auth/microsoft"; }}
            >
              Re-authorize Microsoft 365
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ── Integrations grouped by provider ─────────────────────────────── */}
      {(["google", "microsoft", "other"] as const).map((group) => {
        const items = integrations.filter((i) => i.group === group);
        const groupLabel =
          group === "google"    ? "Google Workspace" :
          group === "microsoft" ? "Microsoft 365" :
                                  "Other integrations";
        const groupIcon =
          group === "google"    ? null :
          group === "microsoft" ? Building2 :
                                  null;
        const GroupIcon = groupIcon;

        return (
          <Card key={group} className="shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                {GroupIcon && <GroupIcon className="h-4 w-4 text-muted-foreground" />}
                {groupLabel}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {items.map((integration, i) => (
                <div key={integration.key}>
                  <div className="flex items-start gap-3">
                    <integration.icon className={`h-5 w-5 mt-0.5 shrink-0 ${integration.color}`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{integration.name}</p>
                      <p className="text-xs text-muted-foreground">{integration.description}</p>
                      {integration.note && (
                        <p className="text-xs text-muted-foreground/70 mt-0.5 italic">{integration.note}</p>
                      )}
                      {integration.status?.error && (
                        <p className="text-xs text-red-600 mt-0.5 truncate">{integration.status.error}</p>
                      )}
                    </div>
                    <StateBadge state={integration.status ? integration.status.state : "loading"} />
                  </div>
                  {i < items.length - 1 && <Separator className="mt-4" />}
                </div>
              ))}
            </CardContent>
          </Card>
        );
      })}

      {/* Profile card — values are stored server-side in sage-settings.json
          and read by the system prompt at every AI call so changes take effect
          immediately on the next conversation turn. */}
      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium">Profile</CardTitle>
          {!editing ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={startEdit}
              disabled={!profile}
              className="gap-1.5 text-xs text-muted-foreground h-7 px-2"
            >
              <Pencil className="h-3 w-3" />
              Edit
            </Button>
          ) : (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={cancelEdit}
                disabled={saving}
                className="gap-1 text-xs text-muted-foreground h-7 px-2"
              >
                <X className="h-3 w-3" />
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={saveEdit}
                disabled={saving || timezoneInvalid}
                className="gap-1 text-xs h-7 px-2 bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)] hover:bg-[oklch(0.78_0.12_85)]"
              >
                {saving
                  ? <Loader2 className="h-3 w-3 animate-spin" />
                  : <Check className="h-3 w-3" />
                }
                Save
              </Button>
            </div>
          )}
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {saveError && (
            <p className="text-xs text-red-600 rounded bg-red-50 px-2 py-1">{saveError}</p>
          )}

          {/* Name */}
          <div className="flex items-center justify-between gap-4 min-h-[28px]">
            <span className="text-muted-foreground shrink-0">Name</span>
            {editing && draft ? (
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                className="h-7 text-sm text-right max-w-[220px]"
              />
            ) : (
              <span className="font-medium">{profile?.name ?? "—"}</span>
            )}
          </div>
          <Separator />

          {/* Timezone */}
          <div className="flex items-start justify-between gap-4 min-h-[28px]">
            <span className="text-muted-foreground shrink-0 mt-1">Timezone</span>
            {editing && draft ? (
              <div className="flex flex-col items-end gap-1">
                <Input
                  value={draft.timezone}
                  onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
                  placeholder="Europe/London"
                  className={`h-7 text-sm text-right max-w-[220px] ${
                    timezoneInvalid ? "border-red-400 focus-visible:ring-red-400" : ""
                  }`}
                />
                {timezoneInvalid && (
                  <p className="text-xs text-red-500">
                    Not a valid IANA timezone (e.g. &quot;Europe/London&quot;)
                  </p>
                )}
              </div>
            ) : (
              <span className="font-medium">{profile?.timezone ?? "—"}</span>
            )}
          </div>
          <Separator />

          {/* Work hours */}
          <div className="flex items-center justify-between gap-4 min-h-[28px]">
            <span className="text-muted-foreground shrink-0">Work hours</span>
            {editing && draft ? (
              <div className="flex items-center gap-1.5">
                <Input
                  value={draft.workStart}
                  onChange={(e) => setDraft({ ...draft, workStart: e.target.value })}
                  placeholder="12:00"
                  className="h-7 text-sm text-right w-[72px]"
                />
                <span className="text-muted-foreground text-xs">–</span>
                <Input
                  value={draft.workEnd}
                  onChange={(e) => setDraft({ ...draft, workEnd: e.target.value })}
                  placeholder="20:00"
                  className="h-7 text-sm text-right w-[72px]"
                />
              </div>
            ) : (
              <span className="font-medium">
                {profile
                  ? `${profile.workStart} – ${profile.workEnd}`
                  : "—"}
              </span>
            )}
          </div>
          <Separator />

          {/* Video tool */}
          <div className="flex items-center justify-between gap-4 min-h-[28px]">
            <span className="text-muted-foreground shrink-0">Video calls</span>
            {editing && draft ? (
              <Input
                value={draft.videoTool}
                onChange={(e) => setDraft({ ...draft, videoTool: e.target.value })}
                placeholder="Zoom"
                className="h-7 text-sm text-right max-w-[220px]"
              />
            ) : (
              <span className="font-medium">
                {profile ? `${profile.videoTool} only` : "—"}
              </span>
            )}
          </div>

          {/* Meeting URL — only shown when editing, too long for display row */}
          {editing && draft && (
            <>
              <Separator />
              <div className="space-y-1.5">
                <span className="text-muted-foreground text-xs">Meeting room URL</span>
                <Input
                  value={draft.meetingUrl}
                  onChange={(e) => setDraft({ ...draft, meetingUrl: e.target.value })}
                  placeholder="https://zoom.us/j/..."
                  className="h-7 text-xs"
                />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Persistence diagnostics — only shown when status has loaded and
          we're on Vercel (snap.isConfigured or there's a failure reason). */}
      {/* ── Intelligence backfill ─────────────────────────────────────────── */}
      {/* Re-runs AI classification on email events that were ingested but never
          produced actions/decisions — useful after upgrading or for first-run. */}
      <Card className="shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <RefreshCw className="h-4 w-4 text-muted-foreground" />
            Intelligence backfill
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-xs text-muted-foreground">
            Re-classifies recent email events that haven&apos;t yet produced actions or decisions.
            Safe to run at any time — existing records are never duplicated.
          </p>
          {reprocessResult && (
            <p className="text-xs text-emerald-700 bg-emerald-50 rounded px-2 py-1.5">
              {reprocessResult}
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            className="w-full text-xs gap-1.5"
            onClick={triggerReprocess}
            disabled={reprocessing}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${reprocessing ? "animate-spin" : ""}`} />
            {reprocessing ? "Queuing…" : "Re-process recent events"}
          </Button>
        </CardContent>
      </Card>

      {snap && (
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Database className="h-4 w-4 text-muted-foreground" />
              Persistence
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs text-muted-foreground">
            {/* Overall health indicator */}
            <div className="flex items-center justify-between">
              <span>Snapshot storage</span>
              {snap.isConfigured ? (
                snap.lastFailureAt && (!snap.lastSuccessAt || snap.lastFailureAt > snap.lastSuccessAt) ? (
                  <Badge className="bg-red-100 text-red-700 border-red-200 gap-1 text-xs">
                    <XCircle className="h-3 w-3" />
                    Failing
                  </Badge>
                ) : snap.lastSuccessAt ? (
                  <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 gap-1 text-xs">
                    <CheckCircle2 className="h-3 w-3" />
                    OK
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="gap-1 text-xs">
                    No writes yet
                  </Badge>
                )
              ) : (
                <Badge className="bg-amber-100 text-amber-700 border-amber-200 gap-1 text-xs">
                  <AlertTriangle className="h-3 w-3" />
                  Not configured
                </Badge>
              )}
            </div>

            {snap.lastSuccessAt && (
              <div className="flex items-center justify-between">
                <span>Last success</span>
                <span className="font-mono">{formatRelativeTime(snap.lastSuccessAt)}</span>
              </div>
            )}

            {snap.lastFailureAt && (
              <div className="flex items-start justify-between gap-4">
                <span className="shrink-0">Last failure</span>
                <span className="text-red-600 text-right truncate max-w-[280px]" title={snap.lastFailureReason ?? ""}>
                  {snap.lastFailureReason
                    ? snap.lastFailureReason.slice(0, 80) + (snap.lastFailureReason.length > 80 ? "…" : "")
                    : formatRelativeTime(snap.lastFailureAt)}
                </span>
              </div>
            )}

            {snap.payloadBytes !== null && (
              <div className="flex items-center justify-between">
                <span>Snapshot size</span>
                <span className={`font-mono ${snap.payloadBytes > 48_000 ? "text-amber-600" : ""}`}>
                  {formatBytes(snap.payloadBytes)}
                  {snap.payloadBytes > 48_000 && " ⚠ near limit"}
                </span>
              </div>
            )}

            {!snap.isConfigured && (
              <p className="text-amber-600 pt-1">
                VERCEL_TOKEN and/or VERCEL_PROJECT_ID not set — store data will not survive cold starts.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
