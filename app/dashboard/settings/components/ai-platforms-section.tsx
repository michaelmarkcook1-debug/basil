"use client";

/**
 * AI Platforms settings section.
 *
 * Shows every tracked platform with its live connection status.  Clicking a
 * row expands it to reveal step-by-step setup instructions plus, where
 * applicable, an API-key input field and connect / disconnect actions.
 */

import { useState, useEffect, useCallback } from "react";
import {
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  Eye,
  EyeOff,
  RefreshCw,
  Cpu,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import type { Platform } from "@/lib/ai-projects/types";

// ── Platform metadata ────────────────────────────────────────────────────────

type ConnectionKind =
  | "auto"          // detected from local environment — no config needed
  | "api-key"       // requires a token / API key entered by the user
  | "env-var"       // configured via environment variable
  | "manual"        // no programmatic access; manual export only
  | "coming-soon";  // not yet supported

interface PlatformDef {
  id: Platform;
  label: string;
  /** Short tagline shown in the collapsed row */
  tagline: string;
  kind: ConnectionKind;
  /** Hex / Tailwind color for the logo dot */
  dotColor: string;
  /** Tailwind classes for the logo background pill */
  logoBg: string;
  logoText: string;
  /** Step-by-step instructions (JSX returned by a render function) */
  instructions: React.ReactNode;
  /** For api-key platforms: label shown on the input */
  keyLabel?: string;
  keyPlaceholder?: string;
  keyHint?: string;
  /** URL to open for "Get key →" link */
  keyUrl?: string;
  /** Settings API field name to save the token under */
  settingsField?: string;
}

const PLATFORMS: PlatformDef[] = [
  // ── Claude Code ─────────────────────────────────────────────────────────
  {
    id: "claude-code",
    label: "Claude Code",
    tagline: "Reads your local Claude Code session files automatically",
    kind: "auto",
    dotColor: "#7c3aed",
    logoBg: "bg-violet-500/10",
    logoText: "text-violet-600",
    instructions: (
      <div className="space-y-2 text-xs text-muted-foreground">
        <p>
          Claude Code sessions are read directly from{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
            ~/.claude/projects/
          </code>{" "}
          on your local machine. No credentials are required.
        </p>
        <p className="text-amber-700 bg-amber-50 rounded px-2 py-1.5 border border-amber-200">
          ℹ️ Local-only — project data is available when Basil runs on this
          machine. It is not synced to the cloud deployment.
        </p>
        <ul className="space-y-1 pl-3 list-disc">
          <li>Each subdirectory under <code className="font-mono text-[11px]">~/.claude/projects/</code> is one project</li>
          <li>JSONL session files inside are parsed for first message and timestamps</li>
          <li>Click <strong>Sync now</strong> on the AI Projects page to refresh</li>
        </ul>
      </div>
    ),
  },

  // ── Claude.ai ───────────────────────────────────────────────────────────
  {
    id: "claude-chat",
    label: "Claude.ai (Chat / Projects)",
    tagline: "Claude web, Cowork and Design — manual export",
    kind: "manual",
    dotColor: "#8b5cf6",
    logoBg: "bg-violet-400/10",
    logoText: "text-violet-500",
    instructions: (
      <div className="space-y-2 text-xs text-muted-foreground">
        <p>
          Claude.ai does not currently expose a public API for reading
          conversation history. You can export your data manually:
        </p>
        <ol className="space-y-2 pl-3 list-decimal">
          <li>
            Open{" "}
            <a
              href="https://claude.ai"
              target="_blank"
              rel="noopener noreferrer"
              className="text-violet-600 underline inline-flex items-center gap-0.5"
            >
              claude.ai <ExternalLink className="h-3 w-3" />
            </a>
          </li>
          <li>Go to <strong>Settings → Privacy → Export data</strong></li>
          <li>Download the ZIP archive — it contains your conversations as JSON</li>
          <li>
            Import is coming soon — Basil will parse the export and surface
            your projects automatically once available.
          </li>
        </ol>
        <p className="text-blue-700 bg-blue-50 rounded px-2 py-1.5 border border-blue-200">
          📌 Watch for a native Claude.ai API — Anthropic is expected to add
          Projects API access in a future update.
        </p>
      </div>
    ),
  },

  // ── GitHub ──────────────────────────────────────────────────────────────
  {
    id: "github",
    label: "GitHub",
    tagline: "Sync recent repositories via Personal Access Token",
    kind: "api-key",
    dotColor: "#24292e",
    logoBg: "bg-zinc-800/10",
    logoText: "text-zinc-700",
    keyLabel: "Personal Access Token",
    keyPlaceholder: "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    keyHint: "Needs repo scope (or public_repo for public repos only)",
    keyUrl: "https://github.com/settings/tokens/new?scopes=repo&description=Basil+AI+Projects",
    settingsField: "githubToken",
    instructions: (
      <div className="space-y-2 text-xs text-muted-foreground">
        <p>
          Basil fetches your 10 most recently pushed repositories to surface
          active GitHub work in AI Projects.
        </p>
        <ol className="space-y-2 pl-3 list-decimal">
          <li>
            Open{" "}
            <a
              href="https://github.com/settings/tokens/new?scopes=repo&description=Basil+AI+Projects"
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-700 underline inline-flex items-center gap-0.5"
            >
              github.com/settings/tokens <ExternalLink className="h-3 w-3" />
            </a>
          </li>
          <li>Choose <strong>Tokens (classic)</strong> → Generate new token</li>
          <li>
            Set expiration (recommend 90 days or no expiry for persistent use)
          </li>
          <li>
            Enable scope: <code className="font-mono bg-muted rounded px-1 py-0.5 text-[11px]">repo</code>{" "}
            (or <code className="font-mono bg-muted rounded px-1 py-0.5 text-[11px]">public_repo</code> for public repos only)
          </li>
          <li>Copy the token and paste it below</li>
        </ol>
      </div>
    ),
  },

  // ── Vercel ──────────────────────────────────────────────────────────────
  {
    id: "vercel",
    label: "Vercel",
    tagline: "Projects and deployments via Vercel REST API",
    kind: "env-var",
    dotColor: "#000000",
    logoBg: "bg-zinc-900/10",
    logoText: "text-zinc-800",
    instructions: (
      <div className="space-y-2 text-xs text-muted-foreground">
        <p>
          Basil reads your Vercel projects and recent deployments via the Vercel
          REST API. No manual configuration is needed when deployed on Vercel —
          the token is automatically available.
        </p>
        <p className="font-medium text-foreground">For local development:</p>
        <ol className="space-y-2 pl-3 list-decimal">
          <li>
            Run{" "}
            <code className="font-mono bg-muted rounded px-1 py-0.5 text-[11px]">
              vercel env pull .env.local
            </code>{" "}
            to provision a <code className="font-mono text-[11px]">VERCEL_TOKEN</code>
          </li>
          <li>
            Or create one manually at{" "}
            <a
              href="https://vercel.com/account/tokens"
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-800 underline inline-flex items-center gap-0.5"
            >
              vercel.com/account/tokens <ExternalLink className="h-3 w-3" />
            </a>
          </li>
          <li>
            Add{" "}
            <code className="font-mono bg-muted rounded px-1 py-0.5 text-[11px]">
              VERCEL_TOKEN=your_token
            </code>{" "}
            to <code className="font-mono text-[11px]">.env.local</code>
          </li>
        </ol>
        <p className="text-amber-700 bg-amber-50 rounded px-2 py-1.5 border border-amber-200">
          ⚙️ Configured via environment variable — no UI input required.
        </p>
      </div>
    ),
  },

  // ── Linear ──────────────────────────────────────────────────────────────
  {
    id: "linear",
    label: "Linear",
    tagline: "Issues and projects via Linear Personal API Key",
    kind: "api-key",
    dotColor: "#5e6ad2",
    logoBg: "bg-violet-600/10",
    logoText: "text-violet-600",
    keyLabel: "Personal API Key",
    keyPlaceholder: "lin_api_xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    keyHint: "Generated in Linear Settings → API",
    keyUrl: "https://linear.app/settings/api",
    settingsField: "linearApiKey",
    instructions: (
      <div className="space-y-2 text-xs text-muted-foreground">
        <p>
          Basil surfaces Linear issues assigned to you and tracks recent team
          activity as relationship signals.
        </p>
        <ol className="space-y-2 pl-3 list-decimal">
          <li>
            Open{" "}
            <a
              href="https://linear.app/settings/api"
              target="_blank"
              rel="noopener noreferrer"
              className="text-violet-600 underline inline-flex items-center gap-0.5"
            >
              linear.app/settings/api <ExternalLink className="h-3 w-3" />
            </a>
          </li>
          <li>
            Click <strong>Create key</strong> under <em>Personal API keys</em>
          </li>
          <li>Give it a name (e.g. &ldquo;Basil&rdquo;) and copy the key</li>
          <li>Paste it below — Basil will verify and save it</li>
        </ol>
      </div>
    ),
  },

  // ── ChatGPT ─────────────────────────────────────────────────────────────
  {
    id: "chatgpt",
    label: "ChatGPT",
    tagline: "Conversation history — manual export only",
    kind: "manual",
    dotColor: "#10a37f",
    logoBg: "bg-emerald-500/10",
    logoText: "text-emerald-600",
    instructions: (
      <div className="space-y-2 text-xs text-muted-foreground">
        <p>
          OpenAI does not provide a public API for reading ChatGPT conversation
          history. You can export your data:
        </p>
        <ol className="space-y-2 pl-3 list-decimal">
          <li>
            Open{" "}
            <a
              href="https://chat.openai.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-600 underline inline-flex items-center gap-0.5"
            >
              chat.openai.com <ExternalLink className="h-3 w-3" />
            </a>
          </li>
          <li>Click your profile icon → <strong>Settings</strong></li>
          <li>Go to <strong>Data Controls → Export data</strong></li>
          <li>
            Click <strong>Export</strong> — OpenAI will email you a link to
            download a ZIP archive
          </li>
          <li>
            The archive contains{" "}
            <code className="font-mono bg-muted rounded px-1 py-0.5 text-[11px]">
              conversations.json
            </code>{" "}
            — manual import coming soon
          </li>
        </ol>
        <p className="text-blue-700 bg-blue-50 rounded px-2 py-1.5 border border-blue-200">
          📌 OpenAI is working on a Conversations API — auto-sync will be added
          when it becomes available.
        </p>
      </div>
    ),
  },

  // ── Codex / OpenAI Assistants ────────────────────────────────────────────
  {
    id: "codex",
    label: "Codex (OpenAI)",
    tagline: "OpenAI Assistants API — surfaces your AI threads as projects",
    kind: "api-key",
    dotColor: "#ff6b35",
    logoBg: "bg-orange-500/10",
    logoText: "text-orange-600",
    keyLabel: "OpenAI API Key",
    keyPlaceholder: "sk-…",
    keyHint: "Needs access to the Assistants API (any standard key works)",
    keyUrl: "https://platform.openai.com/api-keys",
    settingsField: "openaiApiKey",
    instructions: (
      <div className="space-y-2 text-xs text-muted-foreground">
        <p>
          Basil reads your OpenAI Assistant threads and surfaces them as AI
          projects. Any recent conversation with an Assistant appears as a
          tracked project with automatic work/personal classification.
        </p>
        <ol className="space-y-1 pl-4 list-decimal">
          <li>
            Go to{" "}
            <a
              href="https://platform.openai.com/api-keys"
              target="_blank"
              rel="noopener noreferrer"
              className="underline inline-flex items-center gap-0.5"
            >
              platform.openai.com/api-keys <ExternalLink className="h-3 w-3" />
            </a>
          </li>
          <li>Click <strong>Create new secret key</strong></li>
          <li>
            Give it a name (e.g. <em>Basil</em>) — no special permissions needed,
            any standard key has Assistants API access
          </li>
          <li>Copy the key and paste it below — it starts with <code className="font-mono text-[11px]">sk-</code></li>
        </ol>
        <p className="text-amber-700 bg-amber-50 rounded px-2 py-1.5 border border-amber-200">
          ⚠️ Your key is stored securely in your Basil account and is never
          shared or used for anything other than reading your own threads.
        </p>
      </div>
    ),
  },

  // ── Gemini ──────────────────────────────────────────────────────────────
  {
    id: "gemini",
    label: "Gemini (Google)",
    tagline: "Google AI Studio — export not yet available",
    kind: "coming-soon",
    dotColor: "#4285f4",
    logoBg: "bg-blue-500/10",
    logoText: "text-blue-600",
    instructions: (
      <div className="space-y-2 text-xs text-muted-foreground">
        <p>
          Google AI Studio (Gemini) does not currently offer an API for reading
          conversation history or a data export feature.
        </p>
        <p className="text-blue-700 bg-blue-50 rounded px-2 py-1.5 border border-blue-200">
          🔜 Auto-sync will be added as soon as Google publishes a Gemini
          history API. Watch{" "}
          <a
            href="https://ai.google.dev"
            target="_blank"
            rel="noopener noreferrer"
            className="underline inline-flex items-center gap-0.5"
          >
            ai.google.dev <ExternalLink className="h-3 w-3" />
          </a>{" "}
          for updates.
        </p>
      </div>
    ),
  },

  // ── Perplexity ──────────────────────────────────────────────────────────
  {
    id: "perplexity",
    label: "Perplexity",
    tagline: "AI search history — no API available yet",
    kind: "coming-soon",
    dotColor: "#20b2aa",
    logoBg: "bg-teal-500/10",
    logoText: "text-teal-600",
    instructions: (
      <div className="space-y-2 text-xs text-muted-foreground">
        <p>
          Perplexity AI does not offer an API for reading search or conversation
          history. There is currently no export option either.
        </p>
        <p className="text-blue-700 bg-blue-50 rounded px-2 py-1.5 border border-blue-200">
          🔜 Integration will be added when Perplexity publishes a history API.
          Follow{" "}
          <a
            href="https://docs.perplexity.ai"
            target="_blank"
            rel="noopener noreferrer"
            className="underline inline-flex items-center gap-0.5"
          >
            docs.perplexity.ai <ExternalLink className="h-3 w-3" />
          </a>{" "}
          for updates.
        </p>
      </div>
    ),
  },

  // ── Grok ────────────────────────────────────────────────────────────────
  {
    id: "grok",
    label: "Grok (xAI)",
    tagline: "xAI Grok history — no API available yet",
    kind: "coming-soon",
    dotColor: "#1da1f2",
    logoBg: "bg-sky-500/10",
    logoText: "text-sky-600",
    instructions: (
      <div className="space-y-2 text-xs text-muted-foreground">
        <p>
          xAI&apos;s Grok does not currently provide a public API for reading
          conversation history or a data export feature.
        </p>
        <p className="text-blue-700 bg-blue-50 rounded px-2 py-1.5 border border-blue-200">
          🔜 Integration will be added when xAI publishes a Grok history API.
          Follow{" "}
          <a
            href="https://x.ai"
            target="_blank"
            rel="noopener noreferrer"
            className="underline inline-flex items-center gap-0.5"
          >
            x.ai <ExternalLink className="h-3 w-3" />
          </a>{" "}
          for updates.
        </p>
      </div>
    ),
  },
];

// ── Status dot ───────────────────────────────────────────────────────────────

function StatusDot({ kind, connected }: { kind: ConnectionKind; connected: boolean }) {
  if (kind === "coming-soon") {
    return (
      <span className="h-2 w-2 rounded-full bg-zinc-300 dark:bg-zinc-600 shrink-0" title="Coming soon" />
    );
  }
  if (kind === "manual") {
    return (
      <span className="h-2 w-2 rounded-full bg-amber-400 shrink-0" title="Manual export only" />
    );
  }
  return connected ? (
    <span className="h-2 w-2 rounded-full bg-emerald-500 shrink-0" title="Connected" />
  ) : (
    <span className="h-2 w-2 rounded-full bg-zinc-300 dark:bg-zinc-600 shrink-0" title="Not connected" />
  );
}

function StatusLabel({ kind, connected }: { kind: ConnectionKind; connected: boolean }) {
  if (kind === "coming-soon") return (
    <Badge variant="secondary" className="text-[11px] h-5 px-1.5 text-zinc-500">Coming soon</Badge>
  );
  if (kind === "auto" && connected) return (
    <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 text-[11px] h-5 px-1.5">
      <CheckCircle2 className="h-2.5 w-2.5 mr-1" />Auto-detected
    </Badge>
  );
  if (kind === "manual") return (
    <Badge className="bg-amber-100 text-amber-700 border-amber-200 text-[11px] h-5 px-1.5">Manual export</Badge>
  );
  if (kind === "env-var") return connected ? (
    <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 text-[11px] h-5 px-1.5">
      <CheckCircle2 className="h-2.5 w-2.5 mr-1" />Connected
    </Badge>
  ) : (
    <Badge variant="secondary" className="text-[11px] h-5 px-1.5 text-zinc-500">Via env var</Badge>
  );
  if (connected) return (
    <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 text-[11px] h-5 px-1.5">
      <CheckCircle2 className="h-2.5 w-2.5 mr-1" />Connected
    </Badge>
  );
  return (
    <Badge variant="secondary" className="text-[11px] h-5 px-1.5 text-zinc-500">
      <XCircle className="h-2.5 w-2.5 mr-1" />Not connected
    </Badge>
  );
}

// ── Platform row ─────────────────────────────────────────────────────────────

interface ConnectedState {
  github: boolean;
  linear: boolean;
  vercel: boolean;
  "claude-code": boolean;
  [key: string]: boolean;
}

interface PlatformRowProps {
  def: PlatformDef;
  connected: boolean;
  onConnect: (field: string, value: string) => Promise<{ ok: boolean; error?: string }>;
  onDisconnect: (field: string) => Promise<{ ok: boolean; error?: string }>;
}

function PlatformRow({ def, connected, onConnect, onDisconnect }: PlatformRowProps) {
  const [open, setOpen] = useState(false);
  const [keyValue, setKeyValue] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  async function handleConnect() {
    if (!def.settingsField || !keyValue.trim()) return;
    setSaving(true);
    setError(null);
    const result = await onConnect(def.settingsField, keyValue.trim());
    if (result.ok) {
      setKeyValue("");
    } else {
      setError(result.error ?? "Connection failed");
    }
    setSaving(false);
  }

  async function handleDisconnect() {
    if (!def.settingsField) return;
    setDisconnecting(true);
    setError(null);
    const result = await onDisconnect(def.settingsField);
    if (!result.ok) {
      setError(result.error ?? "Disconnect failed");
    }
    setDisconnecting(false);
  }

  const canConnect = def.kind === "api-key" && !connected;
  const canDisconnect = def.kind === "api-key" && connected;

  return (
    <div className="border-b border-border/60 last:border-0">
      {/* ── Collapsed row ─────────────────────────────────────────────── */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors text-left"
      >
        {/* Logo pill */}
        <span
          className={`h-7 w-7 rounded-md flex items-center justify-center text-[11px] font-bold shrink-0 ${def.logoBg} ${def.logoText}`}
        >
          {def.label.slice(0, 2).toUpperCase()}
        </span>

        {/* Name + tagline */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium leading-tight">{def.label}</p>
          <p className="text-[12px] text-muted-foreground truncate">{def.tagline}</p>
        </div>

        {/* Status */}
        <div className="flex items-center gap-2 shrink-0">
          <StatusDot kind={def.kind} connected={connected} />
          <span className="hidden sm:block">
            <StatusLabel kind={def.kind} connected={connected} />
          </span>
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </div>
      </button>

      {/* ── Expanded panel ────────────────────────────────────────────── */}
      {open && (
        <div className="px-4 pb-4 space-y-4 bg-muted/20 border-t border-border/40">
          {/* Instructions */}
          <div className="pt-4">{def.instructions}</div>

          {/* API key input — only for api-key platforms that aren't connected */}
          {canConnect && def.settingsField && (
            <>
              <Separator />
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-muted-foreground">
                    {def.keyLabel ?? "API Key"}
                  </label>
                  {def.keyUrl && (
                    <a
                      href={def.keyUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] text-muted-foreground hover:text-foreground underline inline-flex items-center gap-0.5"
                    >
                      Get key <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                  )}
                </div>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input
                      type={showKey ? "text" : "password"}
                      value={keyValue}
                      onChange={(e) => { setKeyValue(e.target.value); setError(null); }}
                      onKeyDown={(e) => { if (e.key === "Enter") void handleConnect(); }}
                      placeholder={def.keyPlaceholder ?? "Paste key here…"}
                      className="h-8 text-[13px] pr-8 font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey((v) => !v)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      tabIndex={-1}
                    >
                      {showKey ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                    </button>
                  </div>
                  <Button
                    size="sm"
                    className="h-8 text-xs shrink-0"
                    onClick={handleConnect}
                    disabled={saving || !keyValue.trim()}
                  >
                    {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : "Connect"}
                  </Button>
                </div>
                {def.keyHint && (
                  <p className="text-[11px] text-muted-foreground">{def.keyHint}</p>
                )}
                {error && (
                  <p className="text-[11px] text-destructive bg-destructive/10 rounded px-2 py-1">
                    {error}
                  </p>
                )}
              </div>
            </>
          )}

          {/* Disconnect button — only for api-key platforms that ARE connected */}
          {canDisconnect && (
            <>
              <Separator />
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">
                    Token saved — Basil is syncing from {def.label}.
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs text-muted-foreground hover:text-destructive"
                    onClick={handleDisconnect}
                    disabled={disconnecting}
                  >
                    {disconnecting ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      "Disconnect"
                    )}
                  </Button>
                </div>
                {error && (
                  <p className="text-[11px] text-destructive bg-destructive/10 rounded px-2 py-1">
                    {error}
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main section component ────────────────────────────────────────────────────

interface AIPlatformsSectionProps {
  /** Pre-loaded connection state from the parent settings page */
  githubConnected: boolean;
  linearConnected: boolean;
  vercelConnected: boolean;
  onSettingsPatch: (patch: Record<string, string>) => Promise<{ ok: boolean; error?: string }>;
}

export function AIPlatformsSection({
  githubConnected,
  linearConnected: linearConnectedProp,
  vercelConnected,
  onSettingsPatch,
}: AIPlatformsSectionProps) {
  const [claudeCodeDetected, setClaudeCodeDetected] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  const [vercelDetected, setVercelDetected] = useState(false);
  // Local state so we can update immediately after connect/disconnect
  const [linearConnected, setLinearConnected] = useState(linearConnectedProp);

  // Detect auto-connected platforms by calling /api/ai-projects
  useEffect(() => {
    fetch("/api/ai-projects")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { platforms?: Record<string, { connected?: boolean }> }) => {
        setClaudeCodeDetected(d?.platforms?.["claude-code"]?.connected === true);
        setVercelDetected(d?.platforms?.["vercel"]?.connected === true);
      })
      .catch((e: unknown) => {
        console.error("[basil-fetch] server_error", { route: "/api/ai-projects", component: "AIPlatformsSection", error: e instanceof Error ? e.message : String(e) });
      });
  }, []);

  function isConnected(platform: Platform): boolean {
    switch (platform) {
      case "claude-code": return claudeCodeDetected;
      case "github":      return githubConnected;
      case "linear":      return linearConnected;
      case "vercel":      return vercelDetected || vercelConnected;
      default:            return false;
    }
  }

  async function handleConnect(field: string, value: string) {
    // Linear uses a different endpoint
    if (field === "linearApiKey") {
      try {
        const res = await fetch("/api/integrations/linear", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey: value }),
        });
        const json = await res.json();
        if (!res.ok) return { ok: false, error: json.error ?? "Connection failed" };
        setLinearConnected(true);
        return { ok: true };
      } catch {
        return { ok: false, error: "Network error" };
      }
    }
    // Everything else goes through PATCH /api/settings
    return onSettingsPatch({ [field]: value });
  }

  async function handleDisconnect(field: string): Promise<{ ok: boolean; error?: string }> {
    if (field === "linearApiKey") {
      try {
        const res = await fetch("/api/integrations/linear", { method: "DELETE" });
        let json: { error?: string } = {};
        try { json = await res.json() as { error?: string }; } catch (e) {
          console.error("[basil-fetch] json_parse_error", { route: "/api/integrations/linear", status: res.status, component: "AIPlatformsSection", error: e instanceof Error ? e.message : String(e) });
        }
        if (!res.ok) return { ok: false, error: json.error ?? "Disconnect failed" };
        setLinearConnected(false);
        return { ok: true };
      } catch {
        return { ok: false, error: "Network error" };
      }
    }
    return onSettingsPatch({ [field]: "" });
  }

  async function handleSyncNow() {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/ai-projects", { method: "POST" });
      if (res.ok) {
        const d = await res.json();
        const count = d?.projects?.length ?? 0;
        setSyncResult(`Sync complete — ${count} project${count !== 1 ? "s" : ""} found`);
      } else {
        setSyncResult("Sync failed — please try again");
      }
    } catch {
      setSyncResult("Network error during sync");
    } finally {
      setSyncing(false);
    }
  }

  const connectedCount = PLATFORMS.filter(
    (p) => p.kind !== "coming-soon" && p.kind !== "manual" && isConnected(p.id)
  ).length;

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Cpu className="h-4 w-4 text-[oklch(0.72_0.15_85)]" />
          AI Platforms
          <Badge variant="secondary" className="text-[11px] h-5 px-1.5 tabular-nums">
            {connectedCount} connected
          </Badge>
        </CardTitle>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs gap-1.5 text-muted-foreground"
          onClick={handleSyncNow}
          disabled={syncing}
        >
          <RefreshCw className={`h-3 w-3 ${syncing ? "animate-spin" : ""}`} />
          {syncing ? "Syncing…" : "Sync now"}
        </Button>
      </CardHeader>

      {syncResult && (
        <div className="mx-4 mb-3 rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-xs text-emerald-700">
          {syncResult}
        </div>
      )}

      <CardContent className="p-0 pb-1">
        <p className="px-4 pb-3 text-xs text-muted-foreground">
          Click any platform to see its connection status and setup instructions.
        </p>
        <div>
          {PLATFORMS.map((def) => (
            <PlatformRow
              key={def.id}
              def={def}
              connected={isConnected(def.id)}
              onConnect={handleConnect}
              onDisconnect={handleDisconnect}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
