"use client";

import React, { useEffect, useMemo, useState } from "react";
import { AIPlatformsSection } from "./components/ai-platforms-section";
import { HealthPanel } from "./components/health-panel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import type { IntegrationStatus, IntegrationState } from "@/lib/integrations/types";
import { clearSessionUsername } from "@/lib/session-user";
import type { ReadinessReport } from "@/lib/readiness";
import {
  AlertTriangle,
  Apple,
  Bot,
  Calendar,
  CheckCircle2,
  ClipboardCheck,
  Copy,
  Database,
  ExternalLink,
  FileText,
  Globe2,
  Hash,
  Info,
  KeyRound,
  Loader2,
  Lock,
  Mail,
  MessageCircle,
  RefreshCw,
  Settings,
  ShieldCheck,
  Trash2,
  Video,
  XCircle,
} from "lucide-react";

interface ReadinessBannerData {
  readiness: { score: number; checks: boolean[] };
  model?: { openaiReady: boolean; gatewayReady: boolean };
  appSources?: Record<string, { state?: string }>;
}

interface SnapshotDiagnostics {
  isConfigured:      boolean;
  lastAttemptAt:     string | null;
  lastSuccessAt:     string | null;
  lastFailureAt:     string | null;
  lastFailureReason: string | null;
  payloadBytes:      number | null;
}

interface AllStatuses {
  google: IntegrationStatus & { google?: { calendar: boolean; gmail: boolean; drive: boolean } };
  slack: IntegrationStatus;
  microsoft?: IntegrationStatus & { microsoft?: { mail: boolean; calendar: boolean; drive: boolean; teams: boolean } };
  linear?: IntegrationStatus;
  claude: IntegrationStatus;
  zoom?: IntegrationStatus;
  snapshot?: SnapshotDiagnostics;
}

interface HealthResponse {
  checks?: {
    storage?: string;
    env?: Record<string, boolean>;
  };
  environment?: string;
}

interface StigStatusResponse {
  ok: boolean;
  embedded: boolean;
  name: string;
  generatedAt: string;
  model?: {
    providerMode: string;
    fast: string;
    default: string;
    long: string;
    openaiReady: boolean;
    gatewayReady: boolean;
  };
  auth?: {
    session: boolean;
    tokenAuthConfigured: boolean;
  };
  endpoints?: Record<string, string>;
  appSources?: Record<string, { state?: string; id?: string }>;
  aiSources?: Record<string, { state?: string; id?: string; label?: string }>;
  projectTruth?: {
    projects: number;
    blocked: number;
    aiWork: number;
    sourceCounts?: Record<string, number>;
  } | null;
  authMode?: "session" | "token";
}

interface UserSettings {
  username?: string;
  email?: string;
  name: string;
  timezone: string;
  workStart: string;
  workEnd: string;
  videoTool: string;
  meetingUrl: string;
  useIpTimezone?: boolean;
  profile?: {
    firstName?: string;
    surname?: string;
    email?: string;
    country?: string;
  };
}

type AppKey = "slack" | "google" | "linear" | "zoom" | "notion" | "apple" | "whatsapp" | "microsoft";

interface AppDef {
  key: AppKey;
  name: string;
  role: string;
  priority: "primary" | "core" | "optional" | "manual";
  icon: React.ElementType;
  status?: IntegrationStatus | null;
  mode: "oauth" | "api-key" | "manual" | "planned";
  connectUrl?: string;
  disconnect?: () => Promise<void>;
  scopes?: string[];
  setup?: string[];
}

function StateBadge({ state, mode }: { state?: IntegrationState | "loading"; mode?: "manual" | "planned" }) {
  if (mode === "manual") return <Badge className="bg-slate-100 text-slate-600 border-slate-200 text-xs">Manual</Badge>;
  if (mode === "planned") return <Badge className="bg-slate-100 text-slate-500 border-slate-200 text-xs">Planned</Badge>;
  if (!state || state === "loading") {
    return <Badge variant="secondary" className="gap-1 text-xs"><Loader2 className="h-3 w-3 animate-spin" />Checking</Badge>;
  }
  if (state === "connected") {
    return <Badge className="bg-emerald-100 text-emerald-800 border-emerald-300 gap-1 text-xs font-semibold"><CheckCircle2 className="h-3 w-3" />Connected</Badge>;
  }
  if (state === "permission_missing" || state === "token_expired") {
    return <Badge className="bg-amber-100 text-amber-800 border-amber-400 gap-1 text-xs font-semibold"><AlertTriangle className="h-3 w-3" />Needs re-auth</Badge>;
  }
  if (state === "error") {
    return <Badge className="bg-red-100 text-red-800 border-red-400 gap-1 text-xs font-semibold"><XCircle className="h-3 w-3" />Error</Badge>;
  }
  return <Badge className="bg-slate-100 text-slate-600 border-slate-300 gap-1 text-xs"><XCircle className="h-3 w-3" />Not connected</Badge>;
}

function isConnected(status?: IntegrationStatus | null) {
  return status?.state === "connected" || status?.state === "permission_missing";
}

function missingEnv(env: Record<string, boolean> | undefined, keys: string[]) {
  return keys.filter((k) => !env?.[k]);
}

function copyText(value: string, setter: (value: string | null) => void) {
  void navigator.clipboard.writeText(value).then(() => {
    setter(value);
    setTimeout(() => setter(null), 1400);
  }).catch((err) => {
    console.error("[settings] clipboard copy failed:", err instanceof Error ? err.message : String(err));
  });
}

function EnvPill({ value, copied, setCopied }: { value: string; copied: boolean; setCopied: (value: string | null) => void }) {
  return (
    <button
      type="button"
      onClick={() => copyText(value, setCopied)}
      className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 font-mono text-[11px] hover:bg-muted/80"
      title="Click to copy"
    >
      {value}
      {copied ? <ClipboardCheck className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
    </button>
  );
}

// ── Readiness Tab ─────────────────────────────────────────────────────────────

function ReadinessTab() {
  const [report, setReport] = useState<ReadinessReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/readiness")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) setReport(data as ReadinessReport); })
      .catch((e: unknown) => { console.error("[settings] readiness fetch failed:", e instanceof Error ? e.message : String(e)); })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-16 rounded-lg bg-muted/40 animate-pulse" />
        ))}
      </div>
    );
  }

  if (!report) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
        Could not load readiness data. Check server logs.
      </div>
    );
  }

  const encryptionCheck = report.checks.find((c) => c.id === "encryption_key");
  const modelCheck = report.checks.find((c) => c.id === "model_config");

  return (
    <div className="space-y-4">
      {/* Score banner */}
      <div className={`rounded-xl border-2 px-5 py-4 flex items-center justify-between gap-4 ${report.score === 100 ? "border-emerald-300 bg-emerald-50" : report.blockers.length > 0 ? "border-red-300 bg-red-50" : "border-amber-300 bg-amber-50"}`}>
        <div className="space-y-0.5">
          <p className={`text-sm font-bold ${report.score === 100 ? "text-emerald-800" : report.blockers.length > 0 ? "text-red-800" : "text-amber-800"}`}>
            {report.score === 100 ? "Basil is fully configured" : report.blockers.length > 0 ? "Action required — blockers detected" : "Almost there — warnings to review"}
          </p>
          <p className={`text-xs font-medium ${report.score === 100 ? "text-emerald-700" : report.blockers.length > 0 ? "text-red-700" : "text-amber-700"}`}>
            {report.checks.filter((c) => c.ok).length} of {report.checks.length} checks passing
          </p>
        </div>
        <div className={`text-3xl font-black tabular-nums ${report.score === 100 ? "text-emerald-600" : report.blockers.length > 0 ? "text-red-600" : "text-amber-600"}`}>
          {report.score}%
        </div>
      </div>

      {/* Blocker banners */}
      {encryptionCheck && !encryptionCheck.ok && (
        <div className="rounded-xl border-2 border-red-400 bg-red-50 px-5 py-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-bold text-red-800">Token encryption key missing — credentials cannot be saved securely.</p>
            <p className="text-xs text-red-700 mt-1 font-medium">Set <code className="bg-red-100 border border-red-200 rounded px-1">BASIL_TOKEN_ENCRYPTION_KEY</code> in Vercel env vars.</p>
          </div>
        </div>
      )}

      {modelCheck && !modelCheck.ok && (
        <div className="rounded-xl border-2 border-red-400 bg-red-50 px-5 py-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-bold text-red-800">AI brain not configured — Chat and briefings will not work.</p>
            <p className="text-xs text-red-700 mt-1 font-medium">
              Add <code className="bg-red-100 border border-red-200 rounded px-1">openai_basilv2</code> (value: your OpenAI API key) in Vercel env vars, or run{" "}
              <code className="bg-red-100 border border-red-200 rounded px-1">vercel env pull .env.local</code> for Vercel AI Gateway.
            </p>
          </div>
        </div>
      )}

      {/* All checks as rows */}
      <div className="divide-y divide-border/60 rounded-xl border overflow-hidden">
        {report.checks.map((check) => (
          <div
            key={check.id}
            className={`flex items-start gap-3 px-4 py-3 border-l-[3px] ${
              check.ok
                ? "border-l-emerald-400 bg-card"
                : check.severity === "blocker"
                ? "border-l-red-500 bg-red-50/60"
                : check.severity === "warning"
                ? "border-l-amber-400 bg-amber-50/40"
                : "border-l-slate-300 bg-card"
            }`}
          >
            <div className="shrink-0 mt-0.5">
              {check.ok ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              ) : check.severity === "blocker" ? (
                <AlertTriangle className="h-4 w-4 text-red-600" />
              ) : check.severity === "warning" ? (
                <AlertTriangle className="h-4 w-4 text-amber-500" />
              ) : (
                <Info className="h-4 w-4 text-muted-foreground" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold">{check.label}</p>
                {!check.ok && (
                  <Badge
                    className={
                      check.severity === "blocker"
                        ? "bg-red-100 text-red-700 border-red-300 text-[11px] font-semibold"
                        : check.severity === "warning"
                        ? "bg-amber-100 text-amber-800 border-amber-300 text-[11px] font-semibold"
                        : "bg-muted text-muted-foreground text-[11px]"
                    }
                  >
                    {check.severity}
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">{check.detail}</p>
              {!check.ok && check.action && (
                <p className={`text-xs mt-1 font-medium ${check.severity === "blocker" ? "text-red-700" : check.severity === "warning" ? "text-amber-700" : "text-muted-foreground"}`}>
                  Fix: {check.action}
                </p>
              )}
            </div>
            <div className="shrink-0">
              {check.ok ? (
                <span className="text-xs font-bold text-emerald-600">Pass</span>
              ) : check.severity === "blocker" ? (
                <span className="text-xs font-bold text-red-600">Blocker</span>
              ) : check.severity === "warning" ? (
                <span className="text-xs font-bold text-amber-600">Warn</span>
              ) : (
                <span className="text-xs font-medium text-muted-foreground">Info</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Stig API Tab ──────────────────────────────────────────────────────────────

function StigApiTab({
  status,
  env,
  copied,
  setCopied,
}: {
  status: StigStatusResponse | null;
  env: Record<string, boolean> | undefined;
  copied: string | null;
  setCopied: (value: string | null) => void;
}) {
  const endpoints = status?.endpoints ?? {
    status: "/api/stig/status",
    ask: "/api/stig/ask",
    siri: "/api/stig/siri",
    briefing: "/api/stig/briefing",
  };
  const tokenReady = !!status?.auth?.tokenAuthConfigured;
  const openaiReady = !!status?.model?.openaiReady;
  const gatewayReady = !!status?.model?.gatewayReady;
  const modelReady = openaiReady || gatewayReady;
  const providerMode = status?.model?.providerMode ?? "openai_direct";
  const sourceStates = Object.entries(status?.appSources ?? {});
  const aiStates = Object.entries(status?.aiSources ?? {});

  const [testResult, setTestResult] = React.useState<{ ok: boolean; text?: string; durationMs?: number; error?: { message: string } } | null>(null);
  const [testing, setTesting] = React.useState(false);

  async function testBrain() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/ai/test-brain");
      const data = await res.json() as { ok: boolean; text?: string; durationMs?: number; error?: { message: string } };
      setTestResult(data);
    } catch {
      setTestResult({ ok: false, error: { message: "Network error contacting test endpoint" } });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card className="border-[oklch(0.72_0.15_85)]/30 bg-[oklch(0.72_0.15_85)]/[0.04] shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <Bot className="h-4 w-4 text-[oklch(0.58_0.15_85)]" />
                The Stig API
              </CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                Embedded inside Basil. Use it from the dashboard, mobile app, Siri shortcut, or future Slack command.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge className={status?.embedded ? "bg-emerald-100 text-emerald-700 border-emerald-200" : "bg-amber-100 text-amber-700 border-amber-200"}>
                {status?.embedded ? "Embedded" : "Checking"}
              </Badge>
              <Badge className={modelReady ? "bg-emerald-100 text-emerald-800 border-emerald-300 font-semibold" : "bg-red-100 text-red-800 border-red-400 font-semibold"}>
                {modelReady
                  ? (openaiReady ? "OpenAI ready" : "Gateway ready")
                  : "AI brain missing"}
              </Badge>
              <Badge className={tokenReady ? "bg-emerald-100 text-emerald-700 border-emerald-200" : "bg-muted text-muted-foreground"}>
                {tokenReady ? "Phone token ready" : "Phone token off"}
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {!modelReady && (
            <div className="rounded-lg border-2 border-red-300 bg-red-50 p-3 text-xs text-red-800 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-red-600 mt-0.5" />
              <div>
                <strong className="font-bold">AI brain not configured.</strong>{" "}Set{" "}
                <EnvPill value="openai_basilv2" copied={copied === "openai_basilv2"} setCopied={setCopied} />{" "}
                (value: your OpenAI API key) in Vercel env vars. Or run <code className="bg-red-100 border border-red-200 rounded px-1">vercel env pull .env.local</code> for Vercel AI Gateway.
              </div>
            </div>
          )}
          {modelReady && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800 flex items-center justify-between gap-3 flex-wrap">
              <div>
                <strong>{openaiReady ? "OpenAI direct" : "Vercel AI Gateway"}</strong> is ready.
                {providerMode === "openai_direct" && status?.model?.default && (
                  <span className="ml-1">Model: <code className="bg-emerald-100 rounded px-1">{status.model.default}</code></span>
                )}
              </div>
              <button
                type="button"
                onClick={() => void testBrain()}
                disabled={testing}
                className="shrink-0 rounded-md border border-emerald-300 bg-white/60 px-2.5 py-1 text-[11px] font-medium text-emerald-800 hover:bg-white disabled:opacity-50"
              >
                {testing ? "Testing…" : "Test brain →"}
              </button>
            </div>
          )}
          {testResult && (
            <div className={`rounded-lg border p-3 text-xs ${testResult.ok ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-800"}`}>
              {testResult.ok
                ? <>✓ OpenAI responded in {testResult.durationMs}ms: <em>&ldquo;{testResult.text}&rdquo;</em></>
                : <>✗ Test failed: {testResult.error?.message}</>}
            </div>
          )}

          {!tokenReady && (
            <div className="rounded-lg border border-muted bg-background/60 p-3 text-xs text-muted-foreground">
              For Siri/phone access without a browser session, set{" "}
              <EnvPill value="STIG_API_TOKEN" copied={copied === "STIG_API_TOKEN"} setCopied={setCopied} /> and{" "}
              <EnvPill value="STIG_API_USERNAME" copied={copied === "STIG_API_USERNAME"} setCopied={setCopied} />.
              Browser calls still work with the normal Basil login session.
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border bg-card p-3">
              <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Endpoints</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {Object.values(endpoints).map((endpoint) => (
                  <button
                    key={endpoint}
                    type="button"
                    onClick={() => copyText(endpoint, setCopied)}
                    className="rounded-md bg-muted px-2 py-1 font-mono text-[11px] hover:bg-muted/80"
                  >
                    {endpoint} {copied === endpoint ? "✓" : ""}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-xl border bg-card p-3">
              <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Model</p>
              <p className="mt-2 text-sm font-medium">{status?.model?.default ?? "checking"}</p>
              <p className="text-xs text-muted-foreground">Mode: {status?.model?.providerMode ?? "unknown"}</p>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-xl border bg-card p-3">
              <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Project truth</p>
              <p className="mt-2 text-2xl font-semibold">{status?.projectTruth?.projects ?? 0}</p>
              <p className="text-xs text-muted-foreground">{status?.projectTruth?.blocked ?? 0} blocked · {status?.projectTruth?.aiWork ?? 0} AI work</p>
            </div>
            <div className="rounded-xl border bg-card p-3 md:col-span-2">
              <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Source state</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {sourceStates.map(([key, value]) => (
                  <Badge key={key} variant={value.state === "connected" ? "default" : "secondary"} className="text-xs">
                    {key}: {value.state ?? "unknown"}
                  </Badge>
                ))}
                {aiStates.map(([key, value]) => (
                  <Badge key={`ai-${key}`} variant={value.state === "connected" ? "default" : "secondary"} className="text-xs">
                    {key}: {value.state ?? "unknown"}
                  </Badge>
                ))}
                {sourceStates.length === 0 && aiStates.length === 0 && <span className="text-xs text-muted-foreground">Checking sources…</span>}
              </div>
            </div>
          </div>

          {env && !env.STIG_API_TOKEN && (
            <p className="text-[11px] text-muted-foreground">
              STIG_API_TOKEN is optional but recommended before exposing Siri or external API access. Sensible. Unfashionably secure.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Connection Card (Core Apps tab) ──────────────────────────────────────────

function ConnectionCard({
  app,
  linearKey,
  setLinearKey,
  linearSaving,
  linearError,
  onLinearConnect,
}: {
  app: AppDef;
  linearKey: string;
  setLinearKey: (value: string) => void;
  linearSaving: boolean;
  linearError: string | null;
  onLinearConnect: () => Promise<void>;
}) {
  const Icon = app.icon;
  const connected = isConnected(app.status);

  return (
    <Card className={`shadow-sm overflow-hidden ${app.priority === "primary" ? "border-l-4 border-l-emerald-500" : app.priority === "core" ? "border-l-4 border-l-blue-400" : "border-l-4 border-l-slate-200"}`}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className={`rounded-lg p-2 ${isConnected(app.status) ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground"}`}>
              <Icon className="h-4 w-4" />
            </div>
            <div>
              <CardTitle className="text-sm font-semibold flex flex-wrap items-center gap-2">
                {app.name}
                {app.priority === "primary" && <Badge className="bg-emerald-700 text-white border-0 text-[11px]">Primary</Badge>}
              </CardTitle>
              <p className="mt-1 text-xs text-muted-foreground leading-snug">{app.role}</p>
            </div>
          </div>
          <StateBadge state={app.status?.state} mode={app.mode === "manual" || app.mode === "planned" ? app.mode : undefined} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {app.status?.error && (
          <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 font-medium">{app.status.error}</p>
        )}

        {app.setup && app.setup.length > 0 && (
          <div className="space-y-0.5">
            {app.setup.map((line) => <p key={line} className="text-xs text-muted-foreground">· {line}</p>)}
          </div>
        )}

        {app.key === "linear" && !connected ? (
          <div className="space-y-2">
            <div className="flex gap-2">
              <Input
                type="password"
                placeholder="lin_api_…"
                value={linearKey}
                onChange={(e) => setLinearKey(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void onLinearConnect(); }}
                className="h-9 font-mono text-xs"
              />
              <Button size="sm" className="h-9 gap-1.5" onClick={onLinearConnect} disabled={linearSaving || !linearKey.trim()}>
                {linearSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
                Connect
              </Button>
            </div>
            {linearError && <p className="text-xs text-red-600">{linearError}</p>}
            <a className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground underline" href="https://linear.app/settings/api" target="_blank" rel="noreferrer">
              Get Linear API key <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        ) : app.mode === "oauth" ? (
          <div className="flex flex-wrap gap-2">
            {connected ? (
              <Button variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground hover:text-destructive" onClick={() => void app.disconnect?.()}>
                Disconnect
              </Button>
            ) : (
              <Button
                size="sm"
                className="h-8 text-xs"
                disabled={!app.connectUrl}
                title={!app.connectUrl ? "Missing required environment variables — see setup notes above" : undefined}
                onClick={() => { if (app.connectUrl) window.location.href = app.connectUrl; }}
              >
                Connect
              </Button>
            )}
            {(app.status?.state === "permission_missing" || app.status?.state === "token_expired") && app.connectUrl && (
              <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => { window.location.href = app.connectUrl!; }}>
                Re-authorize
              </Button>
            )}
          </div>
        ) : app.key === "linear" && connected ? (
          <Button variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground hover:text-destructive" onClick={() => void app.disconnect?.()}>
            Disconnect
          </Button>
        ) : app.key === "whatsapp" ? (
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => { window.location.href = "/dashboard/whatsapp"; }}>
            Open WhatsApp import
          </Button>
        ) : app.mode === "manual" ? (
          <Badge className="bg-amber-100 text-amber-700 border-amber-200">Manual / import only</Badge>
        ) : (
          <Badge variant="secondary">Planned</Badge>
        )}

        {app.scopes && app.scopes.length > 0 && (
          <p className="text-[11px] text-muted-foreground">Scopes: {app.scopes.slice(0, 5).join(", ")}{app.scopes.length > 5 ? "…" : ""}</p>
        )}
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const [statuses, setStatuses] = useState<AllStatuses | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [stigStatus, setStigStatus] = useState<StigStatusResponse | null>(null);
  const [readiness, setReadiness] = useState<ReadinessBannerData | null>(null);
  const [profile, setProfile] = useState<UserSettings | null>(null);
  const [draft, setDraft] = useState<UserSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const [linearKey, setLinearKey] = useState("");
  const [linearSaving, setLinearSaving] = useState(false);
  const [linearError, setLinearError] = useState<string | null>(null);

  const [savingProfile, setSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMessage, setPwMessage] = useState<string | null>(null);

  const [reprocessing, setReprocessing] = useState(false);
  const [reprocessResult, setReprocessResult] = useState<string | null>(null);

  const [deleteText, setDeleteText] = useState("");
  const [deleting, setDeleting] = useState(false);

  // Read ?tab= from URL to support deep links (e.g. ?tab=apps)
  // Map legacy tab names to new names for backwards compat
  const TAB_ALIASES: Record<string, string> = {
    readiness: "setup",
    "core-apps": "apps",
    "ai-platforms": "apps",
    "stig-api": "brain",
  };
  const [activeTab, setActiveTab] = useState<string>("setup");
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get("tab");
    if (tab) setActiveTab(TAB_ALIASES[tab] ?? tab);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadAll() {
    setLoading(true);
    try {
      const [statusRes, healthRes, settingsRes, stigRes, readinessRes] = await Promise.all([
        fetch("/api/integrations/status"),
        fetch("/api/health"),
        fetch("/api/settings"),
        fetch("/api/stig/status"),
        fetch("/api/settings/readiness"),
      ]);

      if (statusRes.ok) {
        setStatuses(await statusRes.json() as AllStatuses);
      } else {
        const detail = await statusRes.text();
        setNotice({ type: "error", message: `Integration status failed: ${detail.slice(0, 200)}` });
      }

      if (healthRes.ok) setHealth(await healthRes.json() as HealthResponse);

      if (settingsRes.ok) {
        const data = await settingsRes.json() as UserSettings;
        setProfile(data);
        setDraft(data);
      }

      if (stigRes.ok) {
        setStigStatus(await stigRes.json() as StigStatusResponse);
      } else {
        setStigStatus(null);
      }

      if (readinessRes.ok) {
        setReadiness(await readinessRes.json() as ReadinessBannerData);
      }
    } catch (err) {
      console.error("[settings] load failed:", err instanceof Error ? err.message : String(err));
      setNotice({ type: "error", message: "Could not load settings. Check server logs." });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAll();

    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const error = params.get("error");

    if (connected) setNotice({ type: "success", message: `${connected} connected.` });
    if (error) {
      let errorMessage: string;
      if (error === "microsoft_redirect_mismatch") {
        const appUrl = window.location.origin;
        errorMessage = `Microsoft redirect URI mismatch — add ${appUrl}/api/auth/microsoft/callback to your Azure app's redirect URIs`;
      } else if (error === "microsoft_credentials") {
        errorMessage = "Microsoft client credentials rejected — check MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET";
      } else if (error === "microsoft_auth") {
        errorMessage = "Microsoft connection failed — check your Azure app configuration";
      } else {
        errorMessage = `Connection failed: ${error}`;
      }
      setNotice({ type: "error", message: errorMessage });
    }
    if (connected || error) window.history.replaceState({}, "", window.location.pathname);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function disconnect(path: string, optimisticKey?: keyof AllStatuses) {
    try {
      const res = await fetch(path, { method: "DELETE" });
      if (!res.ok) {
        setNotice({ type: "error", message: `Disconnect failed (${res.status}).` });
        return;
      }
      if (optimisticKey) {
        setStatuses((prev) => prev ? ({
          ...prev,
          [optimisticKey]: {
            ...(prev[optimisticKey] as IntegrationStatus | undefined),
            id: optimisticKey,
            state: "disconnected",
            lastCheckedAt: new Date().toISOString(),
          },
        } as AllStatuses) : prev);
      }
      setTimeout(() => void loadAll(), 800);
    } catch (err) {
      console.error("[settings] disconnect failed:", err instanceof Error ? err.message : String(err));
      setNotice({ type: "error", message: "Network error during disconnect." });
    }
  }

  async function connectLinear() {
    setLinearSaving(true);
    setLinearError(null);
    try {
      const res = await fetch("/api/auth/linear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: linearKey.trim() }),
      });
      const data = await res.json() as { error?: string; displayName?: string; name?: string };
      if (!res.ok) {
        setLinearError(data.error ?? "Linear connection failed.");
        return;
      }
      setLinearKey("");
      const workspaceName = data.displayName ?? data.name;
      setNotice({ type: "success", message: workspaceName ? `Linear connected as ${workspaceName}.` : "Linear connected." });
      await loadAll();
    } catch (err) {
      console.error("[settings] Linear connect failed:", err instanceof Error ? err.message : String(err));
      setLinearError("Network error.");
    } finally {
      setLinearSaving(false);
    }
  }

  async function saveProfile() {
    if (!draft) return;
    setSavingProfile(true);
    setProfileError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          timezone: draft.timezone,
          workStart: draft.workStart,
          workEnd: draft.workEnd,
          videoTool: draft.videoTool,
          meetingUrl: draft.meetingUrl,
          useIpTimezone: draft.useIpTimezone,
        }),
      });
      const data = await res.json() as UserSettings & { error?: string };
      if (!res.ok) {
        setProfileError(data.error ?? "Save failed.");
        return;
      }
      setProfile(data);
      setDraft(data);
      setNotice({ type: "success", message: "Profile saved." });
    } catch (err) {
      console.error("[settings] profile save failed:", err instanceof Error ? err.message : String(err));
      setProfileError("Network error.");
    } finally {
      setSavingProfile(false);
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwMessage(null);
    if (pw.next.length < 8) {
      setPwMessage("New password must be at least 8 characters.");
      return;
    }
    if (pw.next !== pw.confirm) {
      setPwMessage("New passwords do not match.");
      return;
    }
    setPwSaving(true);
    try {
      const res = await fetch("/api/profile/password", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: pw.current, newPassword: pw.next }),
      });
      const data = await res.json() as { error?: string; requiresRelogin?: boolean };
      if (!res.ok) {
        setPwMessage(data.error ?? "Password update failed.");
        return;
      }
      setPw({ current: "", next: "", confirm: "" });
      // All existing sessions are invalidated server-side on password change.
      // Redirect to login immediately so the user re-authenticates with the new password.
      setPwMessage("Password updated. Redirecting to login…");
      setTimeout(() => {
        clearSessionUsername();
        window.location.href = "/login";
      }, 1500);
    } catch (err) {
      console.error("[settings] password update failed:", err instanceof Error ? err.message : String(err));
      setPwMessage("Network error.");
    } finally {
      setPwSaving(false);
    }
  }

  async function triggerReprocess() {
    setReprocessing(true);
    setReprocessResult(null);
    try {
      const res = await fetch("/api/events/reprocess", { method: "POST" });
      const body = await res.json().catch(() => ({})) as { queued?: number; message?: string };
      if (!res.ok) {
        setReprocessResult(`Backfill failed (${res.status}).`);
        return;
      }
      if (body.queued === 0) {
        setReprocessResult("Nothing to classify — all recent events are already processed.");
      } else {
        setReprocessResult(body.message ?? "Backfill queued. Basil will re-classify recent signals.");
      }
    } catch (err) {
      console.error("[settings] backfill failed:", err instanceof Error ? err.message : String(err));
      setReprocessResult("Network error.");
    } finally {
      setReprocessing(false);
    }
  }

  async function deleteAccount() {
    if (deleteText.toLowerCase() !== "delete my account") return;
    setDeleting(true);
    try {
      const res = await fetch("/api/profile", { method: "DELETE" });
      if (res.ok) {
        clearSessionUsername();
        window.location.href = "/login";
        return;
      }
      setNotice({ type: "error", message: "Delete failed." });
    } catch (err) {
      console.error("[settings] delete failed:", err instanceof Error ? err.message : String(err));
      setNotice({ type: "error", message: "Network error during delete." });
    } finally {
      setDeleting(false);
    }
  }

  const env = health?.checks?.env;
  const slackMissing = missingEnv(env, ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET"]);
  const googleMissing = missingEnv(env, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"]);
  const zoomMissing = missingEnv(env, ["ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET", "ZOOM_REDIRECT_URI"]);
  const microsoftMissing = missingEnv(env, ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"]);

  const apps: AppDef[] = useMemo(() => [
    {
      key: "slack",
      name: "Slack",
      role: "Primary operating layer: communication, team blockers, promises, tasks and urgency.",
      priority: "primary",
      icon: Hash,
      status: statuses?.slack,
      mode: "oauth",
      connectUrl: slackMissing.length ? undefined : "/api/auth/slack/oauth?from=settings",
      disconnect: () => disconnect("/api/auth/slack", "slack"),
      setup: (() => {
        const slackConnected = statuses?.slack?.state === "connected";
        if (slackConnected && slackMissing.length) {
          return slackMissing.map(v => `Connected, but ${v} is missing — Slack webhook commands won't work without it. Add it in Vercel env vars.`);
        }
        if (!slackConnected && slackMissing.length) {
          return [`Missing env vars: ${slackMissing.join(", ")}`];
        }
        return ["Connect first. This drives daily briefing urgency."];
      })(),
    },
    {
      key: "google",
      name: "Google Workspace",
      role: "Calendar, Gmail, Drive, Docs and meeting source material.",
      priority: "core",
      icon: Globe2,
      status: statuses?.google,
      mode: "oauth",
      connectUrl: googleMissing.length ? undefined : "/api/auth/google?from=settings",
      disconnect: () => disconnect("/api/auth/google", "google"),
      scopes: statuses?.google?.scopes,
      setup: googleMissing.length ? [`Missing env vars: ${googleMissing.join(", ")}`] : [
        `Calendar: ${statuses?.google?.google?.calendar ? "on" : "off"}`,
        `Gmail: ${statuses?.google?.google?.gmail ? "on" : "off"}`,
        `Drive: ${statuses?.google?.google?.drive ? "on" : "off"}`,
      ],
    },
    {
      key: "linear",
      name: "Linear",
      role: "Product, engineering issues, delivery blockers and roadmap reality.",
      priority: "core",
      icon: Database,
      status: statuses?.linear,
      mode: "api-key",
      disconnect: () => disconnect("/api/integrations/linear", "linear"),
      setup: ["Use a Linear Personal API Key. Basil validates before saving."],
    },
    {
      key: "zoom",
      name: "Zoom",
      role: "Meeting metadata, recordings/transcript routes, participant context.",
      priority: "core",
      icon: Video,
      status: statuses?.zoom,
      mode: "oauth",
      connectUrl: zoomMissing.length ? undefined : "/api/auth/zoom?from=%2Fdashboard%2Fsettings%3Fconnected%3Dzoom",
      disconnect: () => disconnect("/api/auth/zoom", "zoom"),
      setup: zoomMissing.length ? [`Missing env vars: ${zoomMissing.join(", ")}`] : ["Connect for meeting intelligence. Google/Zoom email summaries still work via Gmail signals."],
    },
    {
      key: "whatsapp",
      name: "WhatsApp",
      role: "Manual capture only — no API available. WhatsApp does not provide a third-party inbox API.",
      priority: "manual",
      icon: MessageCircle,
      status: { id: "whatsapp", state: "disconnected", lastCheckedAt: new Date().toISOString() },
      mode: "manual",
      setup: ["Export a chat from WhatsApp and import it via the WhatsApp page. No live sync is possible."],
    },
    {
      key: "notion",
      name: "Notion",
      role: "Company memory and structured docs. Connector not yet implemented in this repo.",
      priority: "optional",
      icon: FileText,
      mode: "planned",
      setup: ["Next build: OAuth + selected pages/databases + project ledger matching."],
    },
    {
      key: "apple",
      name: "Apple / iCloud",
      role: "Personal calendar/reminders. Best handled through calendar sync or native helper later.",
      priority: "optional",
      icon: Apple,
      mode: "planned",
      setup: ["Phase 1: sync Apple Calendar into Google. Phase 2: native Mac/iOS helper."],
    },
    {
      key: "microsoft",
      name: "Microsoft 365",
      role: "Optional fallback for Outlook/Teams/OneDrive if needed.",
      priority: "optional",
      icon: Mail,
      status: statuses?.microsoft,
      mode: "oauth",
      connectUrl: microsoftMissing.length ? undefined : "/api/auth/microsoft?from=settings",
      disconnect: () => disconnect("/api/auth/microsoft", "microsoft"),
      scopes: statuses?.microsoft?.scopes,
      setup: microsoftMissing.length ? [`Missing env vars: ${microsoftMissing.join(", ")}`] : ["Optional in your stack, but kept available."],
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [statuses, slackMissing.join(","), googleMissing.join(","), zoomMissing.join(","), microsoftMissing.join(",")]);

  const connectedApps = apps.filter((a) => isConnected(a.status)).length;
  const needsAttention = apps.filter((a) => a.status?.state === "error" || a.status?.state === "permission_missing" || a.status?.state === "token_expired").length;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 pb-10 sm:p-6 lg:p-8">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Settings className="h-6 w-6 text-[oklch(0.72_0.15_85)]" />
            <h1 className="text-2xl font-semibold tracking-tight">Settings & integrations</h1>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Basil&apos;s control room. Connect the sources that feed the daily briefing, project truth layer and AI command centre.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {statuses !== null && (
            <Badge variant="secondary" className="h-9 px-3 text-sm font-medium">
              <CheckCircle2 className="mr-1.5 h-3.5 w-3.5 text-emerald-600" />{connectedApps} connected
            </Badge>
          )}
          {needsAttention > 0 && (
            <Badge className="h-9 bg-amber-100 px-3 text-amber-900 border-amber-400 font-semibold text-sm">
              <AlertTriangle className="mr-1.5 h-3.5 w-3.5" />{needsAttention} need attention
            </Badge>
          )}
          <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={loadAll} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </header>

      {notice && (
        <div className={`flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm font-medium ${notice.type === "success" ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-red-300 bg-red-50 text-red-800"}`}>
          {notice.type === "success"
            ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
            : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />}
          {notice.message}
          <button type="button" onClick={() => setNotice(null)} className="ml-auto shrink-0 opacity-60 hover:opacity-100">✕</button>
        </div>
      )}

      {/* ── System Readiness Banner ───────────────────────────────────────── */}
      {readiness && (() => {
        const score = readiness.readiness.score;
        const brainReady = readiness.model?.openaiReady || readiness.model?.gatewayReady;
        const isGreen = score === 100;
        const isRed = !brainReady;
        const colorClass = isGreen
          ? "border-emerald-300 bg-emerald-50"
          : isRed
          ? "border-red-300 bg-red-50"
          : "border-amber-300 bg-amber-50";
        const textClass = isGreen ? "text-emerald-800" : isRed ? "text-red-800" : "text-amber-800";
        const subTextClass = isGreen ? "text-emerald-700" : isRed ? "text-red-700" : "text-amber-700";
        const scoreClass = isGreen ? "text-emerald-600" : isRed ? "text-red-600" : "text-amber-600";
        const headline = isGreen
          ? "All core systems ready"
          : isRed
          ? "Brain not configured — Chat and briefings offline"
          : "Partial setup — some integrations missing";
        const subline = isGreen
          ? "Brain, Slack and Google are connected."
          : isRed
          ? "Set openai_basilv2 (value: OpenAI API key) in Vercel env vars to enable AI."
          : "Brain is ready but one or more integrations are not connected.";
        const Icon = isGreen ? CheckCircle2 : AlertTriangle;
        return (
          <div className={`flex items-center justify-between gap-4 rounded-xl border-2 px-5 py-3 ${colorClass}`}>
            <div className="flex items-start gap-3">
              <Icon className={`h-5 w-5 shrink-0 mt-0.5 ${isGreen ? "text-emerald-600" : isRed ? "text-red-600" : "text-amber-600"}`} />
              <div>
                <p className={`text-sm font-bold ${textClass}`}>{headline}</p>
                <p className={`text-xs ${subTextClass}`}>{subline}</p>
              </div>
            </div>
            <div className={`text-2xl font-black tabular-nums shrink-0 ${scoreClass}`}>{score}%</div>
          </div>
        );
      })()}

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="flex flex-wrap h-auto gap-1 bg-muted/60 p-1">
          <TabsTrigger value="setup" className="text-xs font-medium">Setup</TabsTrigger>
          <TabsTrigger value="brain" className="text-xs font-medium">Brain</TabsTrigger>
          <TabsTrigger value="apps" className="text-xs font-medium">Apps</TabsTrigger>
          <TabsTrigger value="profile" className="text-xs">Profile</TabsTrigger>
          <TabsTrigger value="security" className="text-xs">Security</TabsTrigger>
          <TabsTrigger value="advanced" className="text-xs">Advanced</TabsTrigger>
          {/* Legacy deep-link aliases — kept for backwards compat */}
          <TabsTrigger value="readiness" className="hidden" />
          <TabsTrigger value="core-apps" className="hidden" />
          <TabsTrigger value="stig-api" className="hidden" />
          <TabsTrigger value="ai-platforms" className="hidden" />
        </TabsList>

        {/* ── Setup (was Readiness) ────────────────────────────────────────── */}
        <TabsContent value="setup" className="mt-6">
          <ReadinessTab />
        </TabsContent>
        {/* Legacy alias */}
        <TabsContent value="readiness" className="mt-6">
          <ReadinessTab />
        </TabsContent>

        {/* ── Brain (was Stig API) ─────────────────────────────────────────── */}
        <TabsContent value="brain" className="mt-6">
          <StigApiTab status={stigStatus} env={env} copied={copied} setCopied={setCopied} />
        </TabsContent>
        {/* Legacy alias */}
        <TabsContent value="stig-api" className="mt-6">
          <StigApiTab status={stigStatus} env={env} copied={copied} setCopied={setCopied} />
        </TabsContent>

        {/* ── Apps (was Core Apps + AI Platforms) ─────────────────────────── */}
        <TabsContent value="apps" className="mt-6 space-y-6">
          <div>
            <h2 className="text-lg font-semibold">App connections</h2>
            <p className="text-sm text-muted-foreground">
              Slack is the operating core. Google, Linear and Zoom enrich the briefing. The rest are honest about current limits.
            </p>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {apps.map((app) => (
              <ConnectionCard
                key={app.key}
                app={app}
                linearKey={linearKey}
                setLinearKey={setLinearKey}
                linearSaving={linearSaving}
                linearError={linearError}
                onLinearConnect={connectLinear}
              />
            ))}
          </div>
          <div>
            <h2 className="text-lg font-semibold">AI platforms</h2>
            <p className="text-sm text-muted-foreground mb-4">
              Track AI tools used in your work. Basil is the source of truth; AI tools are workers.
            </p>
            <AIPlatformsSection />
          </div>
        </TabsContent>
        {/* Legacy aliases */}
        <TabsContent value="core-apps" className="mt-6 space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            {apps.map((app) => (
              <ConnectionCard
                key={app.key}
                app={app}
                linearKey={linearKey}
                setLinearKey={setLinearKey}
                linearSaving={linearSaving}
                linearError={linearError}
                onLinearConnect={connectLinear}
              />
            ))}
          </div>
        </TabsContent>
        <TabsContent value="ai-platforms" className="mt-6">
          <AIPlatformsSection />
        </TabsContent>

        {/* ── Profile ───────────────────────────────────────────────────────── */}
        <TabsContent value="profile" className="mt-6">
          <Card className="shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold">Profile & working pattern</CardTitle>
              <p className="text-xs text-muted-foreground">Used in prompts, daily briefing time boundaries and scheduling logic.</p>
            </CardHeader>
            <CardContent className="space-y-4">
              {profileError && <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{profileError}</p>}
              <div className="grid gap-3 md:grid-cols-2">
                <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
                  Name
                  <Input value={draft?.name ?? ""} onChange={(e) => setDraft((d) => d ? { ...d, name: e.target.value } : d)} />
                </label>
                <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
                  Timezone
                  <Input value={draft?.timezone ?? ""} onChange={(e) => setDraft((d) => d ? { ...d, timezone: e.target.value } : d)} placeholder="Europe/London" />
                </label>
                <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
                  Work start
                  <Input value={draft?.workStart ?? ""} onChange={(e) => setDraft((d) => d ? { ...d, workStart: e.target.value } : d)} placeholder="09:00" />
                </label>
                <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
                  Work end
                  <Input value={draft?.workEnd ?? ""} onChange={(e) => setDraft((d) => d ? { ...d, workEnd: e.target.value } : d)} placeholder="18:00" />
                </label>
                <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
                  Video tool
                  <Input value={draft?.videoTool ?? ""} onChange={(e) => setDraft((d) => d ? { ...d, videoTool: e.target.value } : d)} placeholder="Zoom" />
                </label>
                <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
                  Meeting URL
                  <Input value={draft?.meetingUrl ?? ""} onChange={(e) => setDraft((d) => d ? { ...d, meetingUrl: e.target.value } : d)} placeholder="https://zoom.us/j/…" />
                </label>
              </div>
              <div className="flex flex-wrap justify-between gap-3">
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={!!draft?.useIpTimezone}
                    onChange={(e) => setDraft((d) => d ? { ...d, useIpTimezone: e.target.checked } : d)}
                  />
                  Detect timezone from IP when available
                </label>
                <Button size="sm" onClick={saveProfile} disabled={savingProfile || !draft}>
                  {savingProfile ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                  Save profile
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Security ──────────────────────────────────────────────────────── */}
        <TabsContent value="security" className="mt-6">
          <Card className="shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <Lock className="h-4 w-4" />
                Security
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={changePassword} className="space-y-3">
                {pwMessage && <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">{pwMessage}</p>}
                <Input type="password" placeholder="Current password" value={pw.current} onChange={(e) => setPw((p) => ({ ...p, current: e.target.value }))} />
                <Input type="password" placeholder="New password" value={pw.next} onChange={(e) => setPw((p) => ({ ...p, next: e.target.value }))} />
                <Input type="password" placeholder="Confirm new password" value={pw.confirm} onChange={(e) => setPw((p) => ({ ...p, confirm: e.target.value }))} />
                <Button size="sm" type="submit" disabled={pwSaving || !pw.current || !pw.next || !pw.confirm}>
                  {pwSaving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                  Update password
                </Button>
              </form>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Advanced ──────────────────────────────────────────────────────── */}
        <TabsContent value="advanced" className="mt-6 space-y-4">
          <HealthPanel />

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold flex items-center gap-2">
                  <RefreshCw className="h-4 w-4" />
                  Intelligence backfill
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Re-run classification across recent Slack, email, Zoom, calendar and imported signals. Safe to run; Basil should not duplicate existing actions.
                </p>
                {reprocessResult && <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">{reprocessResult}</p>}
                <Button variant="outline" size="sm" className="gap-1.5" onClick={triggerReprocess} disabled={reprocessing}>
                  <RefreshCw className={`h-3.5 w-3.5 ${reprocessing ? "animate-spin" : ""}`} />
                  Re-process recent events
                </Button>
              </CardContent>
            </Card>

            <Card className="border-red-200 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold text-red-600 flex items-center gap-2">
                  <Trash2 className="h-4 w-4" />
                  Danger zone
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">Delete your account and all associated user-scoped data. This cannot be undone.</p>
                <Separator />
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input placeholder="type: delete my account" value={deleteText} onChange={(e) => setDeleteText(e.target.value)} />
                  <Button variant="destructive" onClick={deleteAccount} disabled={deleting || deleteText.toLowerCase() !== "delete my account"}>
                    {deleting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                    Delete
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
