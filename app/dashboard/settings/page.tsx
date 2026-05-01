"use client";

import React, { useEffect, useState } from "react";
import { AIPlatformsSection } from "./components/ai-platforms-section";
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
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Copy,
  ClipboardCheck,
  Lock,
  Eye,
  EyeOff,
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
  linear?:    IntegrationStatus;
  claude:     IntegrationStatus;
  zoom?:      IntegrationStatus;
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

// Mirrors UserSettings from lib/settings/store.ts
interface UserSettings {
  name:          string;
  timezone:      string;
  workStart:     string;
  workEnd:       string;
  videoTool:     string;
  meetingUrl:    string;
  useIpTimezone?: boolean;
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
  const [urlNotice, setUrlNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [showAzureGuide, setShowAzureGuide] = useState(false);
  const [copiedEnvVar, setCopiedEnvVar] = useState<string | null>(null);

  // ── Account info (read-only) ─────────────────────────────────────────────
  const [account, setAccount] = useState<{ username: string; email: string } | null>(null);

  // ── Linear API key state ─────────────────────────────────────────────────
  const [linearKey, setLinearKey]       = useState("");
  const [linearSaving, setLinearSaving] = useState(false);
  const [linearError, setLinearError]   = useState<string | null>(null);

  // ── GitHub PAT state ─────────────────────────────────────────────────────
  const [githubKey, setGithubKey]       = useState("");
  const [githubSaving, setGithubSaving] = useState(false);
  const [githubError, setGithubError]   = useState<string | null>(null);
  const [githubConnected, setGithubConnected] = useState(false);

  async function handleGithubConnect() {
    if (!githubKey.trim()) return;
    setGithubSaving(true);
    setGithubError(null);
    try {
      const res = await fetch("/api/settings", {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ githubToken: githubKey.trim() }),
      });
      if (!res.ok) {
        setGithubError("Failed to save token");
        return;
      }
      setGithubKey("");
      setGithubConnected(true);
    } catch {
      setGithubError("Network error — please try again");
    } finally {
      setGithubSaving(false);
    }
  }

  async function handleGithubDisconnect() {
    await fetch("/api/settings", {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ githubToken: "" }),
    });
    setGithubConnected(false);
  }

  async function handleLinearConnect() {
    if (!linearKey.trim()) return;
    setLinearSaving(true);
    setLinearError(null);
    try {
      const res = await fetch("/api/auth/linear", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ apiKey: linearKey.trim() }),
      });
      const json = await res.json();
      if (!res.ok) {
        setLinearError(json.error ?? "Connection failed");
        return;
      }
      setLinearKey("");
      setStatuses((prev) => prev ? {
        ...prev,
        linear: { id: "linear", state: "connected", lastCheckedAt: new Date().toISOString() },
      } : prev);
    } catch {
      setLinearError("Network error — please try again");
    } finally {
      setLinearSaving(false);
    }
  }

  async function handleLinearDisconnect() {
    await fetch("/api/auth/linear", { method: "DELETE" });
    setStatuses((prev) => prev ? {
      ...prev,
      linear: { id: "linear", state: "disconnected", lastCheckedAt: new Date().toISOString() },
    } : prev);
  }

  // ── Profile/settings state ────────────────────────────────────────────────
  const [profile, setProfile]         = useState<UserSettings | null>(null);
  const [editing, setEditing]         = useState(false);
  const [draft, setDraft]             = useState<UserSettings | null>(null);
  const [saving, setSaving]           = useState(false);
  const [saveError, setSaveError]     = useState<string | null>(null);

  async function handleGoogleDisconnect() {
    await fetch("/api/auth/google", { method: "DELETE" });
    // Optimistically update — avoids snapshot propagation race on serverless
    setStatuses((prev) => prev ? {
      ...prev,
      google: { ...(prev.google ?? {}), id: "google", state: "disconnected", lastCheckedAt: new Date().toISOString() },
    } : prev);
    setTimeout(() => void loadStatuses(), 1500);
  }

  async function handleMicrosoftDisconnect() {
    await fetch("/api/auth/microsoft", { method: "DELETE" });
    setStatuses((prev) => prev ? {
      ...prev,
      microsoft: { ...(prev.microsoft ?? {}), id: "microsoft", state: "disconnected", lastCheckedAt: new Date().toISOString() },
    } : prev);
    setTimeout(() => void loadStatuses(), 1500);
  }

  async function handleSlackDisconnect() {
    await fetch("/api/auth/slack", { method: "DELETE" });
    setStatuses((prev) => prev ? {
      ...prev,
      slack: { id: "slack", state: "disconnected", lastCheckedAt: new Date().toISOString() },
    } : prev);
    setTimeout(() => void loadStatuses(), 1500);
  }

  async function handleZoomDisconnect() {
    await fetch("/api/auth/zoom", { method: "DELETE" });
    setStatuses((prev) => prev ? {
      ...prev,
      zoom: { id: "zoom", state: "disconnected", lastCheckedAt: new Date().toISOString() },
    } : prev);
    setTimeout(() => void loadStatuses(), 1500);
  }

  // ── Password change state ─────────────────────────────────────────────────
  const [pwForm, setPwForm] = useState({ current: "", next: "", confirm: "" });
  const [pwSaving, setPwSaving] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSuccess, setPwSuccess] = useState(false);
  const [showPw, setShowPw] = useState(false);

  // Delete account
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleDeleteAccount() {
    if (deleteConfirmText.toLowerCase() !== "delete my account") return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch("/api/profile", { method: "DELETE" });
      if (res.ok) {
        window.location.href = "/login";
      } else {
        const data = await res.json().catch(() => ({}));
        setDeleteError(data.error || "Failed to delete account");
        setDeleting(false);
      }
    } catch {
      setDeleteError("Network error — please try again");
      setDeleting(false);
    }
  }

  async function handlePasswordChange(e: React.FormEvent) {
    e.preventDefault();
    setPwError(null);
    if (pwForm.next.length < 8) {
      setPwError("New password must be at least 8 characters.");
      return;
    }
    if (pwForm.next !== pwForm.confirm) {
      setPwError("New passwords don't match.");
      return;
    }
    setPwSaving(true);
    try {
      const res = await fetch("/api/profile/password", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: pwForm.current, newPassword: pwForm.next }),
      });
      const data = await res.json();
      if (!res.ok) {
        setPwError(data.error ?? "Password change failed.");
        return;
      }
      setPwSuccess(true);
      setPwForm({ current: "", next: "", confirm: "" });
      // All sessions revoked — redirect to login after a moment
      setTimeout(() => { window.location.href = "/login"; }, 2000);
    } catch {
      setPwError("Network error. Please try again.");
    } finally {
      setPwSaving(false);
    }
  }

  // Timezone validation is checked inline as the user types
  const timezoneInvalid =
    editing && draft?.timezone !== undefined && !isValidTimezone(draft.timezone);

  async function loadSettings() {
    try {
      const [settingsRes, profileRes] = await Promise.all([
        fetch("/api/settings", { cache: "no-store" }),
        fetch("/api/profile",  { cache: "no-store" }),
      ]);
      if (settingsRes.ok) {
        const data = await settingsRes.json() as UserSettings & { githubToken?: string };
        setProfile(data);
        setGithubConnected(!!data.githubToken);
      }
      if (profileRes.ok)  setAccount(await profileRes.json());
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

    // Parse OAuth callback params from URL and show a banner, then clean the URL
    const params = new URLSearchParams(window.location.search);
    const error     = params.get("error");
    const connected = params.get("connected");

    if (connected === "slack") {
      setUrlNotice({ type: "success", message: "Slack connected successfully." });
      // Optimistically mark Slack as connected immediately — avoids serverless
      // cold-start race where the status check runs before the snapshot propagates.
      setStatuses((prev) => prev ? {
        ...prev,
        slack: { id: "slack", state: "connected", lastCheckedAt: new Date().toISOString() },
      } : prev);
      // Then refresh for real after a short delay
      setTimeout(() => void loadStatuses(), 1500);
    } else if (connected === "microsoft") {
      setUrlNotice({ type: "success", message: "Microsoft 365 connected successfully." });
      setStatuses((prev) => prev ? {
        ...prev,
        microsoft: { ...(prev.microsoft ?? {}), id: "microsoft", state: "connected", lastCheckedAt: new Date().toISOString() },
      } : prev);
      setTimeout(() => void loadStatuses(), 1500);
    } else if (connected === "google") {
      setUrlNotice({ type: "success", message: "Google connected successfully." });
      setStatuses((prev) => prev ? {
        ...prev,
        google: { ...(prev.google ?? {}), id: "google", state: "connected", lastCheckedAt: new Date().toISOString() },
      } : prev);
      setTimeout(() => void loadStatuses(), 1500);
    } else if (error === "slack_auth") {
      const slackErr = params.get("slack_error");
      setUrlNotice({ type: "error", message: `Slack authorization failed${slackErr ? ` (${slackErr})` : ""} — please try connecting again.` });
    } else if (error === "slack_not_configured") {
      setUrlNotice({
        type: "error",
        message: "Slack OAuth is not configured. Add SLACK_CLIENT_ID and SLACK_CLIENT_SECRET to your Vercel environment variables.",
      });
    } else if (error === "microsoft_not_configured") {
      setUrlNotice({
        type: "error",
        message:
          "Microsoft 365 is not configured yet. Register an Azure AD app and add MICROSOFT_CLIENT_ID + MICROSOFT_CLIENT_SECRET to your Vercel environment variables, then redeploy.",
      });
    } else if (error === "microsoft_admin_consent") {
      setUrlNotice({
        type: "error",
        message:
          "Microsoft blocked the connection — your Azure AD app needs admin consent. In the Azure portal go to App registrations → API permissions → Grant admin consent for your tenant, then try connecting again.",
      });
    } else if (error === "microsoft_auth") {
      setUrlNotice({ type: "error", message: "Microsoft 365 authorization failed — please try connecting again." });
    } else if (error === "no_code") {
      setUrlNotice({ type: "error", message: "Authorization was cancelled or no code was returned." });
    }

    // Remove query params from the URL bar without reloading
    if (error || connected) {
      window.history.replaceState({}, "", window.location.pathname);
    }
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
    note?:       string | null;
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
      key:         "linear",
      name:        "Linear",
      icon:        Database,
      description: "Sync open Linear issues assigned to you as actions",
      color:       "text-violet-500",
      group:       "other",
      status:      statuses?.linear ?? null,
      note:        null,
    },
    {
      key:         "github",
      name:        "GitHub",
      icon:        Bot,
      description: "Sync your recent GitHub repositories in AI Projects",
      color:       "text-zinc-600",
      group:       "other",
      status:      null,
      note:        null,
    },
    {
      key:         "slack",
      name:        "Slack",
      icon:        Hash,
      description: "Read and send Slack messages",
      color:       "text-emerald-500",
      group:       "other",
      status:      statuses?.slack ?? null,
      note:        null,
    },
    {
      key:         "zoom",
      name:        "Zoom",
      icon:        Video,
      description: "Direct Zoom API connection — meetings, recordings & participants",
      color:       "text-blue-400",
      group:       "other",
      status:      statuses?.zoom ?? null,
      note:        null,
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

      {/* OAuth callback notice (success / error from ?connected= or ?error= params) */}
      {urlNotice && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            urlNotice.type === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-amber-200 bg-amber-50 text-amber-800"
          }`}
        >
          {urlNotice.message}
        </div>
      )}



      {/* ── Integrations grouped by provider ─────────────────────────────── */}
      {(["google", "microsoft", "other"] as const).map((group) => {
        const items = integrations.filter((i) => i.group === group);

        // Group-level connection state
        const googleState   = g?.state ?? "disconnected";
        const microsoftState = ms?.state ?? "disconnected";
        const groupConnected =
          group === "google"    ? (googleState === "connected" || googleState === "permission_missing") :
          group === "microsoft" ? (microsoftState === "connected" || microsoftState === "permission_missing") :
          true;
        const groupNeedsReauth =
          group === "google"    ? (googleState === "token_expired" || googleState === "permission_missing") :
          group === "microsoft" ? (microsoftState === "token_expired" || microsoftState === "permission_missing") :
          false;

        const groupLabel =
          group === "google"    ? "Google Workspace" :
          group === "microsoft" ? "Microsoft 365" :
                                  "Other integrations";
        const groupIcon =
          group === "microsoft" ? Building2 : null;
        const GroupIcon = groupIcon;

        return (
          <Card key={group} className="shadow-sm">
            <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                {GroupIcon && <GroupIcon className="h-4 w-4 text-muted-foreground" />}
                {groupLabel}
              </CardTitle>

              {/* Group-level connect / disconnect / re-authorize */}
              {group === "google" && (
                groupConnected ? (
                  <div className="flex items-center gap-2">
                    {groupNeedsReauth && (
                      <Button size="sm" variant="outline"
                        className="h-7 px-2.5 text-xs text-amber-600 border-amber-300 hover:bg-amber-50"
                        onClick={() => { window.location.href = "/api/auth/google?from=settings"; }}>
                        Re-authorize
                      </Button>
                    )}
                    <Button size="sm" variant="ghost"
                      className="h-7 px-2.5 text-xs text-muted-foreground hover:text-red-600"
                      onClick={handleGoogleDisconnect}>
                      Disconnect
                    </Button>
                  </div>
                ) : (
                  <Button size="sm" variant="outline"
                    className="h-7 px-2.5 text-xs text-[oklch(0.58_0.15_85)] border-[oklch(0.72_0.15_85)]/40 hover:bg-[oklch(0.72_0.15_85)]/8"
                    onClick={() => { window.location.href = "/api/auth/google?from=settings"; }}>
                    Connect →
                  </Button>
                )
              )}

              {group === "microsoft" && (
                groupConnected ? (
                  <div className="flex items-center gap-2">
                    {groupNeedsReauth && (
                      <Button size="sm" variant="outline"
                        className="h-7 px-2.5 text-xs text-amber-600 border-amber-300 hover:bg-amber-50"
                        onClick={() => { window.location.href = "/api/auth/microsoft?from=settings"; }}>
                        Re-authorize
                      </Button>
                    )}
                    <Button size="sm" variant="ghost"
                      className="h-7 px-2.5 text-xs text-muted-foreground hover:text-red-600"
                      onClick={handleMicrosoftDisconnect}>
                      Disconnect
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline"
                      className="h-7 px-2.5 text-xs text-blue-600 border-blue-200 hover:bg-blue-50"
                      onClick={() => { window.location.href = "/api/auth/microsoft?from=settings"; }}>
                      Connect →
                    </Button>
                    <button
                      onClick={() => setShowAzureGuide(v => !v)}
                      className="text-xs text-muted-foreground hover:text-foreground underline"
                    >
                      Setup guide
                    </button>
                  </div>
                )
              )}
            </CardHeader>

            {/* Azure AD setup guide — shown below header when toggled */}
            {group === "microsoft" && showAzureGuide && !groupConnected && (
              <div className="mx-4 mb-4 rounded-lg border border-blue-200 bg-blue-50/60 p-4 text-xs text-blue-900/80 space-y-3">
                <p className="font-semibold text-blue-800">One-time Azure AD setup (~5 min):</p>
                <ol className="space-y-2 list-none">
                  <AzureStep n={1}>
                    Go to <a href="https://portal.azure.com" target="_blank" rel="noreferrer" className="underline inline-flex items-center gap-0.5">portal.azure.com <ExternalLink className="h-3 w-3" /></a> → <strong>App registrations</strong> → <strong>New registration</strong>
                  </AzureStep>
                  <AzureStep n={2}>
                    Supported account types: <strong>"Accounts in any organizational directory … and personal Microsoft accounts"</strong>
                  </AzureStep>
                  <AzureStep n={3}>
                    Redirect URI → <strong>Web</strong> → <CopyableCode value="https://basil-app.vercel.app/api/auth/microsoft/callback" copiedEnvVar={copiedEnvVar} setCopiedEnvVar={setCopiedEnvVar} />
                  </AzureStep>
                  <AzureStep n={4}>Copy <span className="font-mono bg-blue-100 px-1 rounded">Application (client) ID</span> → <strong>MICROSOFT_CLIENT_ID</strong></AzureStep>
                  <AzureStep n={5}><strong>Certificates &amp; secrets</strong> → New client secret → copy Value → <strong>MICROSOFT_CLIENT_SECRET</strong></AzureStep>
                  <AzureStep n={6}>
                    <strong>API permissions</strong> → Microsoft Graph → Delegated → add:{" "}
                    <span className="font-mono bg-blue-100 px-1 rounded text-[11px]">Mail.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Files.Read.All Chat.Read User.Read offline_access</span>
                  </AzureStep>
                  <AzureStep n={7}>Add both env vars in <a href="https://vercel.com/dashboard" target="_blank" rel="noreferrer" className="underline inline-flex items-center gap-0.5">Vercel dashboard <ExternalLink className="h-3 w-3" /></a> and redeploy, then click Connect.</AzureStep>
                </ol>
              </div>
            )}

            <CardContent className="space-y-4">
              {items.map((integration, i) => {
                const isConnected = integration.status?.state === "connected";
                const isStatic = integration.key === "claude";
                return (
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

                    {/* Per-row action */}
                    {isStatic ? (
                      /* Zoom / Claude: status badge only — no auth needed */
                      <StateBadge state={integration.status ? integration.status.state : "loading"} />
                    ) : integration.key === "linear" ? (
                      /* Linear: Personal API Key */
                      isConnected ? (
                        <div className="flex items-center gap-2 shrink-0">
                          <StateBadge state="connected" />
                          <Button size="sm" variant="ghost"
                            className="h-7 px-2 text-xs text-muted-foreground hover:text-red-600"
                            onClick={handleLinearDisconnect}>
                            Disconnect
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1.5 shrink-0">
                          <Input
                            type="password"
                            placeholder="lin_api_…"
                            value={linearKey}
                            onChange={(e) => { setLinearKey(e.target.value); setLinearError(null); }}
                            onKeyDown={(e) => { if (e.key === "Enter") void handleLinearConnect(); }}
                            className="h-7 w-40 text-xs"
                            disabled={linearSaving}
                          />
                          <Button size="sm" variant="outline"
                            className="h-7 px-2.5 text-xs text-violet-600 border-violet-200 hover:bg-violet-50"
                            onClick={handleLinearConnect}
                            disabled={linearSaving || !linearKey.trim()}
                          >
                            {linearSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : "Connect"}
                          </Button>
                        </div>
                      )
                    ) : integration.key === "github" ? (
                      /* GitHub: Personal Access Token */
                      githubConnected ? (
                        <div className="flex items-center gap-2 shrink-0">
                          <StateBadge state="connected" />
                          <Button size="sm" variant="ghost"
                            className="h-7 px-2 text-xs text-muted-foreground hover:text-red-600"
                            onClick={handleGithubDisconnect}>
                            Disconnect
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1.5 shrink-0">
                          <Input
                            type="password"
                            placeholder="ghp_…"
                            value={githubKey}
                            onChange={(e) => { setGithubKey(e.target.value); setGithubError(null); }}
                            onKeyDown={(e) => { if (e.key === "Enter") void handleGithubConnect(); }}
                            className="h-7 w-40 text-xs"
                            disabled={githubSaving}
                          />
                          <Button size="sm" variant="outline"
                            className="h-7 px-2.5 text-xs text-zinc-700 border-zinc-300 hover:bg-zinc-50"
                            onClick={handleGithubConnect}
                            disabled={githubSaving || !githubKey.trim()}
                          >
                            {githubSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : "Connect"}
                          </Button>
                        </div>
                      )
                    ) : integration.key === "slack" ? (
                      /* Slack: standalone OAuth */
                      isConnected ? (
                        <div className="flex items-center gap-2 shrink-0">
                          <StateBadge state="connected" />
                          <Button size="sm" variant="ghost"
                            className="h-7 px-2 text-xs text-muted-foreground hover:text-red-600"
                            onClick={handleSlackDisconnect}>
                            Disconnect
                          </Button>
                        </div>
                      ) : (
                        <Button size="sm" variant="outline"
                          className="shrink-0 text-xs h-9 sm:h-7 px-3 sm:px-2.5 text-emerald-600 border-emerald-200 hover:bg-emerald-50 hover:border-emerald-400 gap-1.5"
                          onClick={() => { window.location.href = "/api/auth/slack/oauth?from=settings"; }}>
                          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current" aria-hidden="true">
                            <path d="M5.04 15.17a2.52 2.52 0 0 1-2.52 2.52A2.52 2.52 0 0 1 0 15.17a2.52 2.52 0 0 1 2.52-2.52h2.52v2.52zm1.26 0a2.52 2.52 0 0 1 2.52-2.52 2.52 2.52 0 0 1 2.52 2.52v6.31A2.52 2.52 0 0 1 8.82 24a2.52 2.52 0 0 1-2.52-2.52v-6.31zM8.82 5.04a2.52 2.52 0 0 1-2.52-2.52A2.52 2.52 0 0 1 8.82 0a2.52 2.52 0 0 1 2.52 2.52v2.52H8.82zm0 1.26a2.52 2.52 0 0 1 2.52 2.52 2.52 2.52 0 0 1-2.52 2.52H2.52A2.52 2.52 0 0 1 0 8.82a2.52 2.52 0 0 1 2.52-2.52h6.3zm10.13 2.52a2.52 2.52 0 0 1 2.52-2.52A2.52 2.52 0 0 1 24 8.82a2.52 2.52 0 0 1-2.52 2.52h-2.52V8.82zm-1.26 0a2.52 2.52 0 0 1-2.52 2.52 2.52 2.52 0 0 1-2.52-2.52V2.52A2.52 2.52 0 0 1 15.17 0a2.52 2.52 0 0 1 2.52 2.52v6.3zm-2.52 10.13a2.52 2.52 0 0 1 2.52 2.52A2.52 2.52 0 0 1 15.17 24a2.52 2.52 0 0 1-2.52-2.52v-2.52h2.52zm0-1.26a2.52 2.52 0 0 1-2.52-2.52 2.52 2.52 0 0 1 2.52-2.52h6.31A2.52 2.52 0 0 1 24 15.17a2.52 2.52 0 0 1-2.52 2.52h-6.31z"/>
                          </svg>
                          Connect with Slack
                        </Button>
                      )
                    ) : integration.group === "google" ? (
                      /* Google sub-services: each row has its own connect/disconnect.
                         All Google services share one OAuth token so any row action
                         connects/disconnects the whole Google account. */
                      <div className="flex items-center gap-2 shrink-0">
                        <StateBadge state={
                          statuses === null ? "loading"
                          : integration.status ? integration.status.state
                          : "disconnected"
                        } />
                        {googleConnected ? (
                          <Button size="sm" variant="ghost"
                            className="h-7 px-2 text-xs text-muted-foreground hover:text-red-600"
                            onClick={handleGoogleDisconnect}>
                            Disconnect
                          </Button>
                        ) : (
                          <Button size="sm" variant="outline"
                            className="h-7 px-2.5 text-xs text-[oklch(0.58_0.15_85)] border-[oklch(0.72_0.15_85)]/40 hover:bg-[oklch(0.72_0.15_85)]/8"
                            onClick={() => { window.location.href = "/api/auth/google?from=settings"; }}>
                            Connect →
                          </Button>
                        )}
                      </div>
                    ) : integration.group === "microsoft" ? (
                      /* Microsoft sub-services: same pattern — shared OAuth token. */
                      <div className="flex items-center gap-2 shrink-0">
                        <StateBadge state={
                          statuses === null ? "loading"
                          : integration.status ? integration.status.state
                          : "disconnected"
                        } />
                        {microsoftConnected ? (
                          <Button size="sm" variant="ghost"
                            className="h-7 px-2 text-xs text-muted-foreground hover:text-red-600"
                            onClick={handleMicrosoftDisconnect}>
                            Disconnect
                          </Button>
                        ) : (
                          <Button size="sm" variant="outline"
                            className="h-7 px-2.5 text-xs text-blue-600 border-blue-200 hover:bg-blue-50"
                            onClick={() => { window.location.href = "/api/auth/microsoft?from=settings"; }}>
                            Connect →
                          </Button>
                        )}
                      </div>
                    ) : integration.key === "zoom" ? (
                      /* Zoom: standalone OAuth */
                      isConnected ? (
                        <div className="flex items-center gap-2 shrink-0">
                          <StateBadge state="connected" />
                          <Button size="sm" variant="ghost"
                            className="h-7 px-2 text-xs text-muted-foreground hover:text-red-600"
                            onClick={handleZoomDisconnect}>
                            Disconnect
                          </Button>
                        </div>
                      ) : (
                        <Button size="sm" variant="outline"
                          className="shrink-0 h-7 px-2.5 text-xs text-blue-600 border-blue-200 hover:bg-blue-50"
                          onClick={() => { window.location.href = "/api/auth/zoom?from=%2Fdashboard%2Fsettings%3Fconnected%3Dzoom"; }}>
                          Connect →
                        </Button>
                      )
                    ) : (
                      <StateBadge state={integration.status ? integration.status.state : "loading"} />
                    )}
                  </div>

                  {/* Linear API key error */}
                  {integration.key === "linear" && linearError && (
                    <p className="mt-1.5 text-xs text-red-600">{linearError}</p>
                  )}
                  {/* Linear API key hint when not connected */}
                  {integration.key === "linear" && !isConnected && !linearError && (
                    <p className="mt-1.5 text-xs text-muted-foreground/70">
                      Get your key at{" "}
                      <a href="https://linear.app/settings/api" target="_blank" rel="noreferrer"
                        className="underline hover:text-foreground">
                        linear.app/settings/api
                      </a>
                    </p>
                  )}

                  {/* GitHub PAT error */}
                  {integration.key === "github" && githubError && (
                    <p className="mt-1.5 text-xs text-red-600">{githubError}</p>
                  )}
                  {/* GitHub PAT hint */}
                  {integration.key === "github" && !githubConnected && !githubError && (
                    <p className="mt-1.5 text-xs text-muted-foreground/70">
                      Create a token at{" "}
                      <a href="https://github.com/settings/tokens" target="_blank" rel="noreferrer"
                        className="underline hover:text-foreground">
                        github.com/settings/tokens
                      </a>{" "}
                      with <code className="font-mono bg-muted px-1 rounded">repo</code> scope.
                    </p>
                  )}

                  {i < items.length - 1 && <Separator className="mt-4" />}
                </div>
                );
              })}
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
              className="gap-1.5 text-xs text-muted-foreground h-9 sm:h-7 px-3 sm:px-2"
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
                className="gap-1 text-xs text-muted-foreground h-9 sm:h-7 px-3 sm:px-2"
              >
                <X className="h-3 w-3" />
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={saveEdit}
                disabled={saving || timezoneInvalid}
                className="gap-1 text-xs h-9 sm:h-7 px-3 sm:px-2 bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)] hover:bg-[oklch(0.78_0.12_85)]"
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

          {/* Username */}
          <div className="flex items-center justify-between gap-4 min-h-[44px] sm:min-h-[28px]">
            <span className="text-muted-foreground shrink-0">Username</span>
            <span className="font-medium font-mono text-sm">{account?.username ?? "—"}</span>
          </div>
          <Separator />

          {/* Email */}
          <div className="flex items-center justify-between gap-4 min-h-[44px] sm:min-h-[28px]">
            <span className="text-muted-foreground shrink-0">Email</span>
            <span className="font-medium text-sm">{account?.email || "—"}</span>
          </div>
          <Separator />

          {/* Name */}
          <div className="flex items-center justify-between gap-4 min-h-[44px] sm:min-h-[28px]">
            <span className="text-muted-foreground shrink-0">Name</span>
            {editing && draft ? (
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                className="h-9 sm:h-7 text-[16px] sm:text-sm text-right max-w-[220px] sm:max-w-[220px] w-full"
              />
            ) : (
              <span className="font-medium">{profile?.name ?? "—"}</span>
            )}
          </div>
          <Separator />

          {/* Timezone */}
          <div className="flex items-start justify-between gap-4 min-h-[44px] sm:min-h-[28px]">
            <span className="text-muted-foreground shrink-0 mt-1">Timezone</span>
            {editing && draft ? (
              <div className="flex flex-col items-end gap-1">
                <Input
                  value={draft.timezone}
                  onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
                  placeholder="Europe/London"
                  className={`h-9 sm:h-7 text-[16px] sm:text-sm text-right w-full max-w-[220px] ${
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

          {/* Use IP timezone */}
          <div className="flex items-center justify-between gap-4 min-h-[44px] sm:min-h-[28px]">
            <div className="flex flex-col gap-0.5">
              <span className="text-muted-foreground shrink-0">Detect timezone from location</span>
              <span className="text-xs text-muted-foreground/60">Auto-detects your timezone on each request using your IP address</span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={!!(editing && draft ? draft.useIpTimezone : profile?.useIpTimezone)}
              onClick={async () => {
                const next = !(editing && draft ? draft.useIpTimezone : profile?.useIpTimezone);
                if (editing && draft) {
                  setDraft({ ...draft, useIpTimezone: next });
                } else {
                  // Toggle without entering edit mode — instant save
                  await fetch("/api/settings", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ useIpTimezone: next }),
                  });
                  setProfile((p) => p ? { ...p, useIpTimezone: next } : p);
                }
              }}
              className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${(editing && draft ? draft.useIpTimezone : profile?.useIpTimezone) ? "bg-primary" : "bg-input"}`}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ${(editing && draft ? draft.useIpTimezone : profile?.useIpTimezone) ? "translate-x-5" : "translate-x-0"}`}
              />
            </button>
          </div>
          <Separator />

          {/* Work hours */}
          <div className="flex items-center justify-between gap-4 min-h-[44px] sm:min-h-[28px]">
            <span className="text-muted-foreground shrink-0">Work hours</span>
            {editing && draft ? (
              <div className="flex items-center gap-1.5">
                <Input
                  value={draft.workStart}
                  onChange={(e) => setDraft({ ...draft, workStart: e.target.value })}
                  placeholder="12:00"
                  className="h-9 sm:h-7 text-[16px] sm:text-sm text-right w-[72px]"
                />
                <span className="text-muted-foreground text-xs">–</span>
                <Input
                  value={draft.workEnd}
                  onChange={(e) => setDraft({ ...draft, workEnd: e.target.value })}
                  placeholder="20:00"
                  className="h-9 sm:h-7 text-[16px] sm:text-sm text-right w-[72px]"
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
          <div className="flex items-center justify-between gap-4 min-h-[44px] sm:min-h-[28px]">
            <span className="text-muted-foreground shrink-0">Video calls</span>
            {editing && draft ? (
              <Input
                value={draft.videoTool}
                onChange={(e) => setDraft({ ...draft, videoTool: e.target.value })}
                placeholder="Zoom"
                className="h-9 sm:h-7 text-[16px] sm:text-sm text-right max-w-[220px] sm:max-w-[220px] w-full"
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
                  className="h-9 sm:h-7 text-[16px] sm:text-xs"
                />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Security — password change ───────────────────────────────────── */}
      <Card className="shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Lock className="h-4 w-4 text-muted-foreground" />
            Security
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <p className="text-xs text-muted-foreground mb-4">
            Change your password. After saving, all active sessions will be signed out
            and you&apos;ll need to log in again with your new password.
          </p>

          {pwSuccess ? (
            <div className="flex items-center gap-2 rounded-lg bg-green-50 border border-green-200 text-green-700 px-4 py-3 text-sm dark:bg-green-950/30 dark:border-green-800 dark:text-green-400">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              Password updated. Redirecting to login&hellip;
            </div>
          ) : (
            <form onSubmit={handlePasswordChange} className="space-y-3">
              {pwError && (
                <p className="text-xs text-destructive rounded bg-destructive/10 px-3 py-2">{pwError}</p>
              )}

              {/* Current password */}
              <div className="flex items-center justify-between gap-4 min-h-[44px] sm:min-h-[28px]">
                <label className="text-muted-foreground shrink-0 text-sm">Current password</label>
                <div className="relative">
                  <Input
                    type={showPw ? "text" : "password"}
                    value={pwForm.current}
                    onChange={(e) => setPwForm(f => ({ ...f, current: e.target.value }))}
                    placeholder="••••••••"
                    required
                    className="h-9 sm:h-7 text-[16px] sm:text-sm pr-8 w-full max-w-[220px]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw(v => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    tabIndex={-1}
                    aria-label={showPw ? "Hide password" : "Show password"}
                  >
                    {showPw ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>
              <Separator />

              {/* New password */}
              <div className="flex items-center justify-between gap-4 min-h-[44px] sm:min-h-[28px]">
                <label className="text-muted-foreground shrink-0 text-sm">New password</label>
                <Input
                  type={showPw ? "text" : "password"}
                  value={pwForm.next}
                  onChange={(e) => setPwForm(f => ({ ...f, next: e.target.value }))}
                  placeholder="Min. 8 characters"
                  required
                  minLength={8}
                  className="h-9 sm:h-7 text-[16px] sm:text-sm text-right w-full max-w-[220px]"
                />
              </div>
              <Separator />

              {/* Confirm new password */}
              <div className="flex items-center justify-between gap-4 min-h-[44px] sm:min-h-[28px]">
                <label className="text-muted-foreground shrink-0 text-sm">Confirm new</label>
                <Input
                  type={showPw ? "text" : "password"}
                  value={pwForm.confirm}
                  onChange={(e) => setPwForm(f => ({ ...f, confirm: e.target.value }))}
                  placeholder="Repeat new password"
                  required
                  className="h-9 sm:h-7 text-[16px] sm:text-sm text-right w-full max-w-[220px]"
                />
              </div>

              <div className="pt-1">
                <Button
                  type="submit"
                  size="sm"
                  disabled={pwSaving || !pwForm.current || !pwForm.next || !pwForm.confirm}
                  className="gap-1.5 bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)] hover:bg-[oklch(0.78_0.12_85)]"
                >
                  {pwSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Lock className="h-3.5 w-3.5" />}
                  {pwSaving ? "Saving…" : "Update password"}
                </Button>
              </div>
            </form>
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

      {/* ── AI Platforms ─────────────────────────────────────────────────── */}
      <AIPlatformsSection
        githubConnected={githubConnected}
        linearConnected={statuses?.linear?.state === "connected"}
        vercelConnected={false}
        onSettingsPatch={async (patch) => {
          try {
            const res = await fetch("/api/settings", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(patch),
            });
            if (!res.ok) return { ok: false, error: "Failed to save" };
            // Reflect updated GitHub connection state
            if ("githubToken" in patch) {
              setGithubConnected(!!patch.githubToken);
            }
            return { ok: true };
          } catch {
            return { ok: false, error: "Network error" };
          }
        }}
      />

      {/* ── Danger zone — delete account ─────────────────────────────────── */}
      <Card className="shadow-sm border-red-200 dark:border-red-900/50">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2 text-red-600 dark:text-red-400">
            <XCircle className="h-4 w-4" />
            Danger zone
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-3">
          <p className="text-xs text-muted-foreground">
            Permanently delete your account and all associated data (tokens, settings, events).
            This action cannot be undone.
          </p>
          {!showDeleteConfirm ? (
            <Button
              variant="outline"
              size="sm"
              className="text-xs border-red-300 text-red-600 hover:bg-red-50 hover:border-red-400 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/30"
              onClick={() => setShowDeleteConfirm(true)}
            >
              Delete my account
            </Button>
          ) : (
            <div className="space-y-3 rounded-lg border border-red-200 dark:border-red-900 bg-red-50/50 dark:bg-red-950/20 p-4">
              <p className="text-xs text-red-700 dark:text-red-400 font-medium">
                Type <strong>delete my account</strong> to confirm:
              </p>
              <input
                type="text"
                value={deleteConfirmText}
                onChange={(e) => { setDeleteConfirmText(e.target.value); setDeleteError(null); }}
                placeholder="delete my account"
                className="w-full rounded-lg border border-red-200 dark:border-red-800 bg-white dark:bg-red-950/20 px-3 py-2 text-sm text-red-700 dark:text-red-300 placeholder:text-red-300 dark:placeholder:text-red-700 outline-none focus:border-red-400 focus:ring-1 focus:ring-red-400/30"
              />
              {deleteError && (
                <p className="text-xs text-red-600 dark:text-red-400">{deleteError}</p>
              )}
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  onClick={() => { setShowDeleteConfirm(false); setDeleteConfirmText(""); setDeleteError(null); }}
                  disabled={deleting}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="text-xs bg-red-600 hover:bg-red-700 text-white"
                  onClick={handleDeleteAccount}
                  disabled={deleting || deleteConfirmText.toLowerCase() !== "delete my account"}
                >
                  {deleting ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />Deleting…</> : "Confirm delete"}
                </Button>
              </div>
            </div>
          )}
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

// ── Azure AD guide helpers ────────────────────────────────────────────────────

function AzureStep({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="flex-shrink-0 h-5 w-5 rounded-full bg-blue-600 text-white flex items-center justify-center font-bold text-[10px]">
        {n}
      </span>
      <span className="pt-0.5 leading-relaxed">{children}</span>
    </li>
  );
}

function CopyableCode({
  value,
  copiedEnvVar,
  setCopiedEnvVar,
}: {
  value: string;
  copiedEnvVar: string | null;
  setCopiedEnvVar: (v: string | null) => void;
}) {
  const copied = copiedEnvVar === value;
  return (
    <span
      className="inline-flex items-center gap-1 font-mono bg-blue-100 px-1.5 py-0.5 rounded cursor-pointer hover:bg-blue-200 transition-colors"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopiedEnvVar(value);
        setTimeout(() => setCopiedEnvVar(null), 2000);
      }}
      title="Click to copy"
    >
      {value}
      {copied
        ? <ClipboardCheck className="h-3 w-3 text-emerald-600" />
        : <Copy className="h-3 w-3 text-blue-500" />}
    </span>
  );
}
