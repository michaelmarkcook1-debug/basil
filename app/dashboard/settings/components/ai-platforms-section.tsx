"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  ExternalLink,
  Eye,
  EyeOff,
  RefreshCw,
  Cpu,
  KeyRound,
  Upload,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { IntegrationState } from "@/lib/integrations/types";
import type { Platform } from "@/lib/ai-projects/types";

type ConnectMode = "api-key" | "auto" | "env" | "manual" | "import" | "planned";

interface PlatformDef {
  id: Platform | "openai" | "anthropic";
  label: string;
  role: string;
  mode: ConnectMode;
  keyPlaceholder?: string;
  keyUrl?: string;
  routePlatform?: "github" | "openai" | "anthropic" | "gemini" | "perplexity" | "grok";
  importPlatform?: "chatgpt" | "claude-chat";
  notes: string[];
}

interface CredentialStatus {
  id: string;
  state: IntegrationState;
  lastCheckedAt: string;
  lastSyncedAt?: string;
  error?: string;
  label?: string;
}

interface CredentialResponse {
  platforms?: Record<string, CredentialStatus>;
}

interface AIProjectsResponse {
  platforms?: Record<string, { connected?: boolean; itemCount?: number; error?: string; lastSyncedAt?: string }>;
}

const PLATFORMS: PlatformDef[] = [
  {
    id: "github",
    label: "GitHub",
    role: "Repositories and engineering project movement",
    mode: "api-key",
    routePlatform: "github",
    keyPlaceholder: "ghp_…",
    keyUrl: "https://github.com/settings/tokens",
    notes: ["Use a fine-grained token or classic PAT with repo read access.", "Used by AI Projects and Project Truth Layer."],
  },
  {
    id: "openai",
    label: "OpenAI / Codex",
    role: "Model access, assistants, Codex-adjacent engineering work",
    mode: "api-key",
    routePlatform: "openai",
    keyPlaceholder: "sk-…",
    keyUrl: "https://platform.openai.com/api-keys",
    notes: ["Validates by listing available models.", "Basil does not pretend to read private ChatGPT web history via API."],
  },
  {
    id: "anthropic",
    label: "Claude API",
    role: "Claude model access and second-opinion reasoning",
    mode: "api-key",
    routePlatform: "anthropic",
    keyPlaceholder: "sk-ant-…",
    keyUrl: "https://console.anthropic.com/settings/keys",
    notes: ["Validates by listing available Claude API models.", "Claude.ai / Cowork web history still requires export/manual capture."],
  },
  {
    id: "gemini",
    label: "Gemini API",
    role: "Google AI model access and cross-model project reasoning",
    mode: "api-key",
    routePlatform: "gemini",
    keyPlaceholder: "AIza…",
    keyUrl: "https://aistudio.google.com/app/apikey",
    notes: ["Validates by listing available Gemini models.", "Separate from Google Workspace OAuth."],
  },
  {
    id: "perplexity",
    label: "Perplexity",
    role: "AI research and web search companion",
    mode: "api-key",
    routePlatform: "perplexity",
    keyPlaceholder: "pplx-…",
    keyUrl: "https://www.perplexity.ai/settings/api",
    notes: ["Validates API access. No conversation history API available yet."],
  },
  {
    id: "grok",
    label: "Grok (xAI)",
    role: "xAI's Grok model access",
    mode: "api-key",
    routePlatform: "grok",
    keyPlaceholder: "xai-…",
    keyUrl: "https://console.x.ai/",
    notes: ["Validates API access via xAI's OpenAI-compatible API."],
  },
  {
    id: "claude-code",
    label: "Claude Code",
    role: "Local coding sessions from ~/.claude/projects",
    mode: "auto",
    notes: ["Works only where Basil can read the local filesystem.", "Cloud deployments cannot see your Mac's ~/.claude directory."],
  },
  {
    id: "vercel",
    label: "Vercel",
    role: "Deployments and hosted app project movement",
    mode: "env",
    notes: ["Set VERCEL_TOKEN in environment variables.", "No browser-entered token required."],
  },
  {
    id: "linear",
    label: "Linear",
    role: "Issues and engineering project movement",
    mode: "auto",
    notes: ["Connected via OAuth on the Integrations tab.", "Projects sync automatically when Linear OAuth is active."],
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    role: "Import conversation history from ChatGPT export",
    mode: "import",
    importPlatform: "chatgpt",
    notes: [
      "Export at chatgpt.com → Settings → Data controls → Export data.",
      "Upload the conversations.json file from the downloaded ZIP.",
      "Conversation titles become project entries in your Brain.",
    ],
  },
  {
    id: "claude-chat",
    label: "Claude.ai chats",
    role: "Import conversation history from Claude.ai export",
    mode: "import",
    importPlatform: "claude-chat",
    notes: [
      "Export at claude.ai → Settings → Privacy → Export data.",
      "Upload the conversations.json file from the downloaded ZIP.",
    ],
  },
  {
    id: "claude-cowork",
    label: "Claude Cowork",
    role: "Project workspace capture",
    mode: "manual",
    notes: ["No automatic Basil connector yet.", "Track deliverables through Project Truth Layer until export/import is implemented."],
  },
];

function StateBadge({ state, mode }: { state?: IntegrationState; mode?: ConnectMode }) {
  if (mode === "manual") return <Badge className="bg-signal-warning-subtle text-signal-warning border-signal-warning-border">Manual</Badge>;
  if (mode === "import") return <Badge className="bg-signal-info-subtle text-signal-info border-signal-info-border"><Upload className="h-3 w-3 mr-1" />Import</Badge>;
  if (mode === "planned") return <Badge variant="secondary">Planned</Badge>;
  if (!state) return <Badge variant="secondary"><Loader2 className="h-3 w-3 mr-1 animate-spin" />Checking</Badge>;
  if (state === "connected") return <Badge className="bg-signal-positive-subtle text-signal-positive border-signal-positive-border"><CheckCircle2 className="h-3 w-3 mr-1" />Connected</Badge>;
  if (state === "error") return <Badge className="bg-signal-critical-subtle text-signal-critical border-signal-critical-border"><AlertTriangle className="h-3 w-3 mr-1" />Error</Badge>;
  if (state === "permission_missing" || state === "token_expired") return <Badge className="bg-signal-warning-subtle text-signal-warning border-signal-warning-border"><AlertTriangle className="h-3 w-3 mr-1" />Needs attention</Badge>;
  return <Badge variant="secondary"><XCircle className="h-3 w-3 mr-1" />Not connected</Badge>;
}

function humanTime(iso?: string) {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return "";
  const mins = Math.max(0, Math.floor(diff / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function PlatformCard({
  def,
  status,
  projectStatus,
  onChanged,
}: {
  def: PlatformDef;
  status?: CredentialStatus;
  projectStatus?: { connected?: boolean; itemCount?: number; error?: string; lastSyncedAt?: string };
  onChanged: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const connected = status?.state === "connected" || projectStatus?.connected === true;
  const canConnect = def.mode === "api-key" && def.routePlatform && !connected;
  const canDisconnect = def.mode === "api-key" && def.routePlatform && connected;

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !def.importPlatform) return;
    setUploading(true);
    setMessage(null);
    try {
      const formData = new FormData();
      formData.append("platform", def.importPlatform);
      formData.append("file", file);
      const res = await fetch("/api/ai-projects/upload", { method: "POST", body: formData });
      const data = await res.json() as { error?: string; imported?: number };
      if (!res.ok) {
        setMessage(data.error ?? "Upload failed");
        return;
      }
      setMessage(`Imported ${data.imported ?? 0} conversation${(data.imported ?? 0) === 1 ? "" : "s"}`);
      onChanged();
    } catch (err) {
      console.error("[AIPlatformsSection] upload failed:", err instanceof Error ? err.message : String(err));
      setMessage("Network error during upload");
    } finally {
      setUploading(false);
      // Reset the file input so the same file can be re-uploaded if needed
      e.target.value = "";
    }
  }

  async function connect() {
    if (!def.routePlatform || !apiKey.trim()) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/ai-platforms/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: def.routePlatform, apiKey: apiKey.trim() }),
      });
      const data = await res.json() as { error?: string; label?: string };
      if (!res.ok) {
        setMessage(data.error ?? "Connection failed");
        return;
      }
      setApiKey("");
      setMessage(data.label ? `Connected — ${data.label}` : "Connected");
      onChanged();
    } catch (err) {
      console.error("[AIPlatformsSection] connect failed:", err instanceof Error ? err.message : String(err));
      setMessage("Network error");
    } finally {
      setSaving(false);
    }
  }

  async function disconnect() {
    if (!def.routePlatform) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/ai-platforms/credentials?platform=${encodeURIComponent(def.routePlatform)}`, {
        method: "DELETE",
      });
      const data = await res.json().catch((err) => {
        console.error("[AIPlatformsSection] disconnect json failed:", err instanceof Error ? err.message : String(err));
        return {};
      }) as { error?: string };
      if (!res.ok) {
        setMessage(data.error ?? "Disconnect failed");
        return;
      }
      setMessage("Disconnected");
      onChanged();
    } catch (err) {
      console.error("[AIPlatformsSection] disconnect failed:", err instanceof Error ? err.message : String(err));
      setMessage("Network error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{def.label}</h3>
            <StateBadge state={connected ? "connected" : status?.state} mode={def.mode} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{def.role}</p>
        </div>
        {def.keyUrl && (
          <a href={def.keyUrl} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 shrink-0">
            Get key <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      <div className="mt-3 space-y-1.5">
        {def.notes.map((note) => (
          <p key={note} className="text-xs text-muted-foreground">• {note}</p>
        ))}
        {status?.label && <p className="text-xs text-signal-positive">Verified: {status.label}</p>}
        {projectStatus?.itemCount !== undefined && (
          <p className="text-xs text-muted-foreground">Project items: {projectStatus.itemCount}</p>
        )}
        {projectStatus?.lastSyncedAt && (
          <p className="text-xs text-muted-foreground">Last sync: {humanTime(projectStatus.lastSyncedAt)}</p>
        )}
        {(status?.error || projectStatus?.error || message) && (
          <p className={`text-xs rounded-md px-2 py-1 ${connected ? "bg-signal-positive-subtle text-signal-positive" : "bg-signal-warning-subtle text-signal-warning"}`}>
            {message ?? status?.error ?? projectStatus?.error}
          </p>
        )}
      </div>

      {canConnect && (
        <div className="mt-4 flex gap-2">
          <div className="relative flex-1">
            <Input
              type={showKey ? "text" : "password"}
              placeholder={def.keyPlaceholder ?? "Paste API key"}
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); setMessage(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") void connect(); }}
              className="h-9 pr-9 font-mono text-xs"
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label={showKey ? "Hide key" : "Show key"}
            >
              {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          </div>
          <Button size="sm" className="h-9 gap-1.5" disabled={saving || !apiKey.trim()} onClick={connect}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
            Connect
          </Button>
        </div>
      )}

      {canDisconnect && (
        <div className="mt-4 flex justify-end">
          <Button variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground hover:text-destructive" disabled={saving} onClick={disconnect}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Disconnect"}
          </Button>
        </div>
      )}

      {def.mode === "import" && (
        <div className="mt-4 space-y-2">
          <label className="text-xs text-muted-foreground font-medium">
            Import from export file (.json)
          </label>
          <div className="flex gap-2">
            <Input
              type="file"
              accept=".json,application/json"
              onChange={handleFileUpload}
              className="h-9 text-xs file:text-xs file:mr-2"
              disabled={uploading}
            />
          </div>
          {uploading && (
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              Importing...
            </p>
          )}
        </div>
      )}

      {def.mode === "manual" && (
        <div className="mt-4 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
          <Upload className="h-3.5 w-3.5 inline mr-1" />
          Import workflow not wired yet. Basil will still track related work through Slack, Linear, GitHub, Notion/manual memory and project ledger signals.
        </div>
      )}
    </div>
  );
}

export function AIPlatformsSection() {
  const [credentials, setCredentials] = useState<Record<string, CredentialStatus>>({});
  const [projects, setProjects] = useState<AIProjectsResponse["platforms"]>({});
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [credRes, projectRes] = await Promise.all([
        fetch("/api/ai-platforms/credentials"),
        fetch("/api/ai-projects"),
      ]);

      if (credRes.ok) {
        const data = await credRes.json() as CredentialResponse;
        setCredentials(data.platforms ?? {});
      }

      if (projectRes.ok) {
        const data = await projectRes.json() as AIProjectsResponse;
        setProjects(data.platforms ?? {});
      }
    } catch (err) {
      console.error("[AIPlatformsSection] load failed:", err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function syncNow() {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/ai-projects", { method: "POST" });
      const data = await res.json().catch((err) => {
        console.error("[AIPlatformsSection] sync json failed:", err instanceof Error ? err.message : String(err));
        return {};
      }) as { projects?: unknown[]; error?: string };
      if (!res.ok) {
        setSyncResult(data.error ?? "Sync failed");
        return;
      }
      setSyncResult(`Sync complete — ${data.projects?.length ?? 0} project signals found`);
      await load();
    } catch (err) {
      console.error("[AIPlatformsSection] sync failed:", err instanceof Error ? err.message : String(err));
      setSyncResult("Network error during sync");
    } finally {
      setSyncing(false);
    }
  }

  const connectedCount = useMemo(() => {
    return PLATFORMS.filter((p) => {
      if (p.routePlatform && credentials[p.routePlatform]?.state === "connected") return true;
      return projects?.[p.id as Platform]?.connected === true;
    }).length;
  }, [credentials, projects]);

  return (
    <Card className="shadow-sm border-signal-warning-border/60">
      <CardHeader className="pb-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <Cpu className="h-4 w-4 text-[color:var(--w-carbon)]" />
              AI Command Centre connections
              {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Connect model APIs and engineering sources. Web-chat histories are marked honestly as manual/export-only.
            </p>
          </div>
          <div className="flex gap-2">
            <Badge variant="secondary" className="h-8 px-3">{connectedCount} active</Badge>
            <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={load}>
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </Button>
            <Button size="sm" className="h-8 gap-1.5" onClick={syncNow} disabled={syncing}>
              <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
              Sync projects
            </Button>
          </div>
        </div>
        {syncResult && (
          <div className="mt-3 rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {syncResult}
          </div>
        )}
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 lg:grid-cols-2">
          {PLATFORMS.map((def) => (
            <PlatformCard
              key={def.id}
              def={def}
              status={def.routePlatform ? credentials[def.routePlatform] : undefined}
              projectStatus={projects?.[def.id as Platform]}
              onChanged={load}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
