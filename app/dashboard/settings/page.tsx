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
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Copy,
  Database,
  ExternalLink,
  FileText,
  Globe2,
  Hash,
  Info,
  Download,
  KeyRound,
  Loader2,
  Lock,
  Mail,
  MessageCircle,
  Mic,
  RefreshCw,
  Settings,
  Smartphone,
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
  briefingEmail?: boolean;
  briefingSlack?: boolean;
  aliasEmails?: string[];
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
  if (mode === "manual") return <Badge className="bg-muted/50 text-muted-foreground border-border text-xs">Manual</Badge>;
  if (mode === "planned") return <Badge className="bg-muted/40 text-muted-foreground/80 border-border text-xs">Planned</Badge>;
  if (!state || state === "loading") {
    return <Badge variant="secondary" className="gap-1 text-xs"><Loader2 className="h-3 w-3 animate-spin" />Checking</Badge>;
  }
  if (state === "connected") {
    return <Badge className="bg-signal-positive-subtle text-signal-positive border-signal-positive-border gap-1 text-xs font-semibold"><CheckCircle2 className="h-3 w-3" />Connected</Badge>;
  }
  if (state === "permission_missing" || state === "token_expired") {
    return <Badge className="bg-signal-warning-subtle text-signal-warning border-signal-warning-border gap-1 text-xs font-semibold"><AlertTriangle className="h-3 w-3" />Needs re-auth</Badge>;
  }
  if (state === "error") {
    return <Badge className="bg-signal-critical-subtle text-signal-critical border-signal-critical-border gap-1 text-xs font-semibold"><XCircle className="h-3 w-3" />Error</Badge>;
  }
  return <Badge className="bg-muted/50 text-muted-foreground border-border gap-1 text-xs"><XCircle className="h-3 w-3" />Not connected</Badge>;
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
      className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 font-mono text-xs hover:bg-muted/80"
      title="Click to copy"
    >
      {value}
      {copied ? <ClipboardCheck className="h-3 w-3 text-signal-positive" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
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
      <div className={`rounded-xl border-2 px-5 py-4 flex items-center justify-between gap-4 ${report.score === 100 ? "border-signal-positive-border bg-signal-positive-subtle" : report.blockers.length > 0 ? "border-signal-critical-border bg-signal-critical-subtle" : "border-signal-warning-border bg-signal-warning-subtle"}`}>
        <div className="space-y-0.5">
          <p className={`text-sm font-bold ${report.score === 100 ? "text-signal-positive" : report.blockers.length > 0 ? "text-signal-critical" : "text-signal-warning"}`}>
            {report.score === 100 ? "Basil is fully configured" : report.blockers.length > 0 ? "Action required — blockers detected" : "Almost there — warnings to review"}
          </p>
          <p className={`text-xs font-medium ${report.score === 100 ? "text-signal-positive" : report.blockers.length > 0 ? "text-signal-critical" : "text-signal-warning"}`}>
            {report.checks.filter((c) => c.ok).length} of {report.checks.length} checks passing
          </p>
        </div>
        <div className={`text-3xl font-black tabular-nums ${report.score === 100 ? "text-signal-positive" : report.blockers.length > 0 ? "text-signal-critical" : "text-signal-warning"}`}>
          {report.score}%
        </div>
      </div>

      {/* Blocker banners */}
      {encryptionCheck && !encryptionCheck.ok && (
        <div className="rounded-xl border-2 border-signal-critical-border bg-signal-critical-subtle px-5 py-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-signal-critical shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-bold text-signal-critical">Token encryption key missing — credentials cannot be saved securely.</p>
            <p className="text-xs text-signal-critical mt-1 font-medium">Set <code className="bg-signal-critical-subtle border border-signal-critical-border rounded px-1">BASIL_TOKEN_ENCRYPTION_KEY</code> in Vercel env vars.</p>
          </div>
        </div>
      )}

      {modelCheck && !modelCheck.ok && (
        <div className="rounded-xl border-2 border-signal-critical-border bg-signal-critical-subtle px-5 py-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-signal-critical shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-bold text-signal-critical">AI brain not configured — Chat and briefings will not work.</p>
            <p className="text-xs text-signal-critical mt-1 font-medium">
              Add <code className="bg-signal-critical-subtle border border-signal-critical-border rounded px-1">openai_basilv2</code> (value: your OpenAI API key) in Vercel env vars, or run{" "}
              <code className="bg-signal-critical-subtle border border-signal-critical-border rounded px-1">vercel env pull .env.local</code> for Vercel AI Gateway.
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
                ? "border-l-red-500 bg-signal-critical-subtle/60"
                : check.severity === "warning"
                ? "border-l-amber-400 bg-signal-warning-subtle"
                : "border-l-slate-300 bg-card"
            }`}
          >
            <div className="shrink-0 mt-0.5">
              {check.ok ? (
                <CheckCircle2 className="h-4 w-4 text-signal-positive" />
              ) : check.severity === "blocker" ? (
                <AlertTriangle className="h-4 w-4 text-signal-critical" />
              ) : check.severity === "warning" ? (
                <AlertTriangle className="h-4 w-4 text-signal-warning" />
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
                        ? "bg-signal-critical-subtle text-signal-critical border-signal-critical-border text-xs font-semibold"
                        : check.severity === "warning"
                        ? "bg-signal-warning-subtle text-signal-warning border-signal-warning-border text-xs font-semibold"
                        : "bg-muted text-muted-foreground text-xs"
                    }
                  >
                    {check.severity}
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">{check.detail}</p>
              {!check.ok && check.action && (
                <p className={`text-xs mt-1 font-medium ${check.severity === "blocker" ? "text-signal-critical" : check.severity === "warning" ? "text-signal-warning" : "text-muted-foreground"}`}>
                  Fix: {check.action}
                </p>
              )}
            </div>
            <div className="shrink-0">
              {check.ok ? (
                <span className="text-xs font-bold text-signal-positive">Pass</span>
              ) : check.severity === "blocker" ? (
                <span className="text-xs font-bold text-signal-critical">Blocker</span>
              ) : check.severity === "warning" ? (
                <span className="text-xs font-bold text-signal-warning">Warn</span>
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

  // Per-user Siri token (self-serve; preferred). Legacy env-token still counts.
  const [siriTokenStatus, setSiriTokenStatus] = React.useState<{ active: boolean; createdAt: string | null; lastUsedAt: string | null } | null>(null);
  const [freshToken, setFreshToken] = React.useState<string | null>(null);
  const [tokenBusy, setTokenBusy] = React.useState(false);
  const [tokenError, setTokenError] = React.useState<string | null>(null);
  React.useEffect(() => {
    fetch("/api/siri/token")
      .then((r) => (r.ok ? r.json() : null))
      .then(setSiriTokenStatus)
      .catch(() => setSiriTokenStatus(null));
  }, []);

  async function generateSiriToken() {
    setTokenBusy(true);
    setTokenError(null);
    try {
      const res = await fetch("/api/siri/token", { method: "POST" });
      if (res.ok) {
        const data = await res.json() as { token: string };
        setFreshToken(data.token);
        setSiriTokenStatus({ active: true, createdAt: new Date().toISOString(), lastUsedAt: null });
      } else {
        setTokenError(`Token generation failed (HTTP ${res.status}). Try again.`);
      }
    } catch {
      setTokenError("Network error generating token. Try again.");
    }
    finally { setTokenBusy(false); }
  }

  async function revokeSiriTokenUi() {
    setTokenBusy(true);
    setTokenError(null);
    try {
      const res = await fetch("/api/siri/token", { method: "DELETE" });
      if (res.ok) {
        setFreshToken(null);
        setSiriTokenStatus({ active: false, createdAt: null, lastUsedAt: null });
      } else {
        setTokenError(`Revoke failed (HTTP ${res.status}). Try again.`);
      }
    } catch {
      setTokenError("Network error revoking token. Try again.");
    }
    finally { setTokenBusy(false); }
  }

  const tokenReady = !!siriTokenStatus?.active || !!status?.auth?.tokenAuthConfigured;
  const openaiReady = !!status?.model?.openaiReady;
  const gatewayReady = !!status?.model?.gatewayReady;
  const modelReady = openaiReady || gatewayReady;
  const providerMode = status?.model?.providerMode ?? "openai_direct";
  const sourceStates = Object.entries(status?.appSources ?? {});
  const aiStates = Object.entries(status?.aiSources ?? {});

  const [testResult, setTestResult] = React.useState<{ ok: boolean; text?: string; durationMs?: number; providerMode?: string; model?: string; error?: string } | null>(null);
  const [testing, setTesting] = React.useState(false);

  const [siriOpen, setSiriOpen] = React.useState(false);
  const [siriTesting, setSiriTesting] = React.useState(false);
  const [siriResult, setSiriResult] = React.useState<{ ok: boolean; text?: string; error?: string } | null>(null);
  const [appUrl, setAppUrl] = React.useState("");
  React.useEffect(() => { setAppUrl(window.location.origin); }, []);

  const siriEndpoint = `${appUrl}/api/stig/siri`;
  const curlSnippet = `curl -s -X POST "${siriEndpoint}" \\
  -H "Content-Type: application/json" \\
  -d '{"question":"What should I focus on today?","token":"YOUR_TOKEN"}'`;

  async function testBrain() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/ai/test-brain");
      const data = await res.json() as { ok: boolean; text?: string; durationMs?: number; providerMode?: string; model?: string; error?: string };
      setTestResult(data);
    } catch {
      setTestResult({ ok: false, error: "Network error contacting test endpoint" });
    } finally {
      setTesting(false);
    }
  }

  async function testSiri() {
    setSiriTesting(true);
    setSiriResult(null);
    try {
      const t0 = Date.now();
      const res = await fetch("/api/stig/siri", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: "What should I focus on right now? Keep your answer to one sentence." }),
      });
      const text = await res.text();
      const ms = Date.now() - t0;
      if (!res.ok) {
        setSiriResult({ ok: false, error: `HTTP ${res.status}: ${text.slice(0, 120)}` });
      } else {
        setSiriResult({ ok: true, text: `(${ms}ms) ${text}` });
      }
    } catch (err) {
      setSiriResult({ ok: false, error: err instanceof Error ? err.message : "Network error" });
    } finally {
      setSiriTesting(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* ── Brain status card ────────────────────────────────────────────── */}
      <Card className="border-[var(--w-rule)] bg-[var(--w-carbon-tint)] shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <Bot className="h-4 w-4 text-[var(--w-carbon)]" />
                The Stig API
              </CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                Embedded inside Basil. Use it from the dashboard, mobile app, Siri shortcut, or future Slack command.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge className={status?.embedded ? "bg-signal-positive-subtle text-signal-positive border-signal-positive-border" : "bg-signal-warning-subtle text-signal-warning border-signal-warning-border"}>
                {status?.embedded ? "Embedded" : "Checking"}
              </Badge>
              <Badge className={modelReady ? "bg-signal-positive-subtle text-signal-positive border-signal-positive-border font-semibold" : "bg-signal-critical-subtle text-signal-critical border-signal-critical-border font-semibold"}>
                {modelReady
                  ? (openaiReady ? "OpenAI ready" : "Gateway ready")
                  : "AI brain missing"}
              </Badge>
              <Badge className={tokenReady ? "bg-signal-positive-subtle text-signal-positive border-signal-positive-border" : "bg-muted text-muted-foreground"}>
                {tokenReady ? "Phone token ready" : "Phone token off"}
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {!modelReady && (
            <div className="rounded-lg border-2 border-signal-critical-border bg-signal-critical-subtle p-3 text-xs text-signal-critical flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-signal-critical mt-0.5" />
              <div>
                <strong className="font-bold">AI brain not configured.</strong>{" "}Set{" "}
                <EnvPill value="openai_basilv2" copied={copied === "openai_basilv2"} setCopied={setCopied} />{" "}
                (value: your OpenAI API key) in Vercel env vars. Or run <code className="bg-signal-critical-subtle border border-signal-critical-border rounded px-1">vercel env pull .env.local</code> for Vercel AI Gateway.
              </div>
            </div>
          )}
          {modelReady && (
            <div className="rounded-lg border border-signal-positive-border bg-signal-positive-subtle p-3 text-xs text-signal-positive flex items-center justify-between gap-3 flex-wrap">
              <div>
                <strong>{openaiReady ? "OpenAI direct" : "Vercel AI Gateway"}</strong> is ready.
                {providerMode === "openai_direct" && status?.model?.default && (
                  <span className="ml-1">Model: <code className="bg-signal-positive-subtle rounded px-1">{status.model.default}</code></span>
                )}
              </div>
              <button
                type="button"
                onClick={() => void testBrain()}
                disabled={testing}
                className="shrink-0 rounded-md border border-signal-positive-border bg-white/60 px-2.5 py-1 text-xs font-medium text-signal-positive hover:bg-white disabled:opacity-50"
              >
                {testing ? "Testing…" : "Test brain →"}
              </button>
            </div>
          )}
          {testResult && (
            <div className={`rounded-lg border p-3 text-xs ${testResult.ok ? "border-signal-positive-border bg-signal-positive-subtle text-signal-positive" : "border-signal-critical-border bg-signal-critical-subtle text-signal-critical"}`}>
              {testResult.ok
                ? <>✓ AI responded in {testResult.durationMs}ms ({testResult.providerMode ?? "direct"}): <em>&ldquo;{testResult.text}&rdquo;</em></>
                : <>✗ Test failed: {testResult.error ?? "unknown error"}</>}
            </div>
          )}

          {!tokenReady && (
            <div className="rounded-lg border border-muted bg-background/60 p-3 text-xs text-muted-foreground">
              For Siri/phone access without a browser session, generate your personal token in{" "}
              <strong>Siri Shortcut setup</strong> just below. Browser calls still work with the
              normal Basil login session.
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border bg-card p-3">
              <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Endpoints</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {Object.values(endpoints).map((endpoint) => (
                  <button
                    key={endpoint}
                    type="button"
                    onClick={() => copyText(endpoint, setCopied)}
                    className="rounded-md bg-muted px-2 py-1 font-mono text-xs hover:bg-muted/80"
                  >
                    {endpoint} {copied === endpoint ? "✓" : ""}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-xl border bg-card p-3">
              <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Model</p>
              <p className="mt-2 text-sm font-medium">{status?.model?.default ?? "checking"}</p>
              <p className="text-xs text-muted-foreground">Mode: {status?.model?.providerMode ?? "unknown"}</p>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-xl border bg-card p-3">
              <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Project truth</p>
              <p className="mt-2 text-2xl font-semibold">{status?.projectTruth?.projects ?? 0}</p>
              <p className="text-xs text-muted-foreground">{status?.projectTruth?.blocked ?? 0} blocked · {status?.projectTruth?.aiWork ?? 0} AI work</p>
            </div>
            <div className="rounded-xl border bg-card p-3 md:col-span-2">
              <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Source state</p>
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

          {env && !env.STIG_API_TOKEN && !siriTokenStatus?.active && (
            <p className="text-xs text-muted-foreground">
              External API access uses your personal Siri token (see Siri Shortcut setup below). Sensible. Unfashionably secure.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Siri Shortcuts setup ─────────────────────────────────────────── */}
      <Card className="shadow-sm overflow-hidden">
        <button
          type="button"
          onClick={() => setSiriOpen((v) => !v)}
          className="w-full text-left"
        >
          <CardHeader className="pb-3 hover:bg-muted/30 transition-colors">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="rounded-lg p-2 bg-muted/50 text-muted-foreground">
                  <Smartphone className="h-4 w-4" />
                </div>
                <div>
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    Siri Shortcut setup
                    {tokenReady
                      ? <Badge className="bg-signal-positive-subtle text-signal-positive border-signal-positive-border text-xs">Token ready</Badge>
                      : <Badge className="bg-signal-warning-subtle text-signal-warning border-signal-warning-border text-xs">Token needed</Badge>}
                  </CardTitle>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Say &ldquo;Hey Siri, ask Basil&rdquo; — Basil answers out loud in 3–5 seconds.
                  </p>
                </div>
              </div>
              {siriOpen
                ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
            </div>
          </CardHeader>
        </button>

        {siriOpen && (
          <CardContent className="space-y-5 pt-0">
            <Separator />

            {/* How it works pill-row */}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium text-muted-foreground">How it works:</span>
              <span className="rounded-full bg-muted px-2.5 py-1 font-medium">1 Dictate Text</span>
              <span className="text-muted-foreground">→</span>
              <span className="rounded-full bg-muted px-2.5 py-1 font-medium">2 Get Contents of URL</span>
              <span className="text-muted-foreground">→</span>
              <span className="rounded-full bg-muted px-2.5 py-1 font-medium">3 Speak Text</span>
            </div>

            {/* Step 1: Token — self-serve, per-user */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${tokenReady ? "bg-signal-positive text-white" : "bg-slate-200 text-slate-700"}`}>1</span>
                <p className="text-sm font-semibold">Get your Siri token</p>
                {tokenReady && <CheckCircle2 className="h-3.5 w-3.5 text-signal-positive" />}
              </div>
              <div className="ml-7 space-y-2">
                {tokenError && (
                  <p className="rounded-md border border-signal-critical-border bg-signal-critical-subtle px-2.5 py-1.5 text-xs text-signal-critical">{tokenError}</p>
                )}
                {freshToken ? (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-signal-warning">
                      Copy it now — for security it&apos;s shown only once. (Lost it? Just regenerate.)
                    </p>
                    <div className="flex items-center gap-2 flex-wrap">
                      <code className="flex-1 min-w-0 rounded-md bg-muted px-2.5 py-1.5 font-mono text-xs break-all">{freshToken}</code>
                      <button
                        type="button"
                        onClick={() => copyText(freshToken, setCopied)}
                        className="shrink-0 inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-muted/60"
                      >
                        {copied === freshToken ? <ClipboardCheck className="h-3 w-3 text-signal-positive" /> : <Copy className="h-3 w-3" />}
                        {copied === freshToken ? "Copied" : "Copy token"}
                      </button>
                    </div>
                    <p className="text-xs text-muted-foreground">Paste it into the Shortcut&apos;s Authorization header in step 3 (after &ldquo;Bearer &rdquo;).</p>
                  </div>
                ) : siriTokenStatus?.active ? (
                  <div className="space-y-2">
                    <p className="text-xs text-signal-positive">
                      ✓ Your personal Siri token is active
                      {siriTokenStatus.createdAt && <> (created {new Date(siriTokenStatus.createdAt).toLocaleDateString()}</>}
                      {siriTokenStatus.createdAt && (siriTokenStatus.lastUsedAt
                        ? <>, last used {new Date(siriTokenStatus.lastUsedAt).toLocaleDateString()})</>
                        : <>, not used yet)</>)}. Siri authenticates without a browser session.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void generateSiriToken()}
                        disabled={tokenBusy}
                        className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-muted/60 disabled:opacity-50"
                      >
                        <RefreshCw className={`h-3 w-3 ${tokenBusy ? "animate-spin" : ""}`} />
                        Regenerate (invalidates the old one)
                      </button>
                      <button
                        type="button"
                        onClick={() => void revokeSiriTokenUi()}
                        disabled={tokenBusy}
                        className="inline-flex items-center gap-1.5 rounded-md border border-signal-critical-border px-2.5 py-1.5 text-xs font-medium text-signal-critical hover:bg-signal-critical-subtle disabled:opacity-50"
                      >
                        <Trash2 className="h-3 w-3" />
                        Revoke
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      Siri can&apos;t use your browser login, so it authenticates with a personal token instead. One click — no configuration needed:
                    </p>
                    <button
                      type="button"
                      onClick={() => void generateSiriToken()}
                      disabled={tokenBusy}
                      className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs font-semibold text-background hover:opacity-90 disabled:opacity-50"
                    >
                      {tokenBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Smartphone className="h-3 w-3" />}
                      Generate my Siri token
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Step 2: Endpoint URL */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-bold text-slate-700">2</span>
                <p className="text-sm font-semibold">Copy your Siri endpoint</p>
              </div>
              <div className="ml-7 space-y-2">
                <p className="text-xs text-muted-foreground">This is the URL you&apos;ll paste into the Shortcut.</p>
                <div className="flex items-center gap-2 flex-wrap">
                  <code className="flex-1 min-w-0 rounded-md bg-muted px-2.5 py-1.5 font-mono text-xs break-all">
                    {siriEndpoint || "Loading…"}
                  </code>
                  {appUrl && (
                    <button
                      type="button"
                      onClick={() => copyText(siriEndpoint, setCopied)}
                      className="shrink-0 inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-muted/60"
                    >
                      {copied === siriEndpoint ? <ClipboardCheck className="h-3 w-3 text-signal-positive" /> : <Copy className="h-3 w-3" />}
                      {copied === siriEndpoint ? "Copied" : "Copy URL"}
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Step 3: Build the Shortcut */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-bold text-slate-700">3</span>
                <p className="text-sm font-semibold">Build the Shortcut in the iOS Shortcuts app</p>
              </div>
              <div className="ml-7 space-y-2">
                <p className="text-xs text-muted-foreground mb-3">Create a new Shortcut with these three actions in order:</p>

                {/* Action cards */}
                <div className="space-y-2">
                  {/* Action 1 */}
                  <div className="rounded-lg border bg-card p-3 flex items-start gap-3">
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-signal-info-subtle text-signal-info">
                      <Mic className="h-3.5 w-3.5" />
                    </div>
                    <div className="space-y-0.5">
                      <p className="text-xs font-semibold">Action 1 — Dictate Text</p>
                      <p className="text-xs text-muted-foreground">Basil listens for your question. Leave all settings at default (Language: default, Stop listening: after pause).</p>
                    </div>
                  </div>

                  {/* Action 2 */}
                  <div className="rounded-lg border bg-card p-3 flex items-start gap-3">
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-signal-info-subtle text-signal-info">
                      <Globe2 className="h-3.5 w-3.5" />
                    </div>
                    <div className="space-y-1.5 flex-1 min-w-0">
                      <p className="text-xs font-semibold">Action 2 — Get Contents of URL</p>
                      <div className="space-y-1 text-xs text-muted-foreground">
                        <div className="flex gap-2">
                          <span className="shrink-0 font-medium text-foreground/70 w-14">URL</span>
                          <span className="font-mono break-all">{siriEndpoint || "/api/stig/siri"}</span>
                        </div>
                        <div className="flex gap-2">
                          <span className="shrink-0 font-medium text-foreground/70 w-14">Method</span>
                          <span className="font-mono">POST</span>
                        </div>
                        <div className="flex gap-2">
                          <span className="shrink-0 font-medium text-foreground/70 w-14">Body</span>
                          <div className="space-y-0.5">
                            <p className="font-mono">JSON — add two fields:</p>
                            <p className="font-mono">question → <em className="not-italic bg-signal-info-subtle border border-signal-info-border rounded px-1 text-signal-info">Dictated Text</em> (select from variables)</p>
                            <p className="font-mono">token → paste your token from step 1</p>
                          </div>
                        </div>
                        <p className="pt-0.5">No headers needed. (Advanced alternative: an <span className="font-mono">Authorization: Bearer &lt;token&gt;</span> header also works.)</p>
                      </div>
                    </div>
                  </div>

                  {/* Action 3 */}
                  <div className="rounded-lg border bg-card p-3 flex items-start gap-3">
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-signal-positive-subtle text-signal-positive">
                      <Apple className="h-3.5 w-3.5" />
                    </div>
                    <div className="space-y-0.5">
                      <p className="text-xs font-semibold">Action 3 — Speak Text</p>
                      <p className="text-xs text-muted-foreground">Pass in the result from step 2. Siri will read Basil&apos;s answer aloud. Set pitch and rate to taste.</p>
                    </div>
                  </div>
                </div>

                <p className="text-xs text-muted-foreground pt-1">
                  Tap the shortcut name and set it to something natural — e.g. <strong>&ldquo;Ask Basil&rdquo;</strong>. Then trigger it with &ldquo;Hey Siri, Ask Basil.&rdquo;
                </p>
              </div>
            </div>

            {/* curl reference */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-bold text-slate-700">4</span>
                <p className="text-sm font-semibold">Test from terminal (optional)</p>
              </div>
              <div className="ml-7 space-y-2">
                <div className="relative rounded-md bg-slate-900 p-3">
                  <pre className="font-mono text-xs text-slate-100 whitespace-pre-wrap break-all">{curlSnippet}</pre>
                  <button
                    type="button"
                    onClick={() => copyText(curlSnippet, setCopied)}
                    className="absolute top-2 right-2 rounded bg-slate-700 px-1.5 py-1 text-xs text-slate-200 hover:bg-slate-600"
                  >
                    {copied === curlSnippet ? "Copied ✓" : "Copy"}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">Replace <code className="bg-muted rounded px-1">YOUR_TOKEN</code> with your personal Siri token from step 1.</p>
              </div>
            </div>

            <Separator />

            {/* Live browser test */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold">Test Siri endpoint right now</p>
                <p className="text-xs text-muted-foreground">Fires a sample question using your current browser session (no token needed).</p>
              </div>
              <button
                type="button"
                onClick={() => void testSiri()}
                disabled={siriTesting}
                className="shrink-0 inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted/60 disabled:opacity-50"
              >
                <Mic className={`h-3.5 w-3.5 ${siriTesting ? "animate-pulse text-signal-critical" : ""}`} />
                {siriTesting ? "Asking Basil…" : "Ask Basil a test question →"}
              </button>
            </div>
            {siriResult && (
              <div className={`rounded-lg border p-3 text-xs ${siriResult.ok ? "border-signal-positive-border bg-signal-positive-subtle text-signal-positive" : "border-signal-critical-border bg-signal-critical-subtle text-signal-critical"}`}>
                {siriResult.ok
                  ? <><span className="font-semibold">Basil says:</span> {siriResult.text}</>
                  : <><span className="font-semibold">Error:</span> {siriResult.error}</>}
              </div>
            )}
          </CardContent>
        )}
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
    <Card className={`shadow-sm overflow-hidden ${app.priority === "primary" ? "border-l border-l-[var(--w-filed)]" : app.priority === "core" ? "border-l border-l-[var(--w-carbon)]" : "border-l border-l-[var(--w-carbon)]"}`}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className={`rounded-lg p-2 ${isConnected(app.status) ? "bg-signal-positive-subtle text-signal-positive" : "bg-muted text-muted-foreground"}`}>
              <Icon className="h-4 w-4" />
            </div>
            <div>
              <CardTitle className="text-sm font-semibold flex flex-wrap items-center gap-2">
                {app.name}
                {app.priority === "primary" && <Badge className="bg-signal-positive text-white border-0 text-xs">Primary</Badge>}
              </CardTitle>
              <p className="mt-1 text-xs text-muted-foreground leading-snug">{app.role}</p>
            </div>
          </div>
          <StateBadge state={app.status?.state} mode={app.mode === "manual" || app.mode === "planned" ? app.mode : undefined} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {app.status?.error && (
          <p className="rounded-md border border-signal-critical-border bg-signal-critical-subtle px-3 py-2 text-xs text-signal-critical font-medium">{app.status.error}</p>
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
            {linearError && <p className="text-xs text-signal-critical">{linearError}</p>}
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
          <Badge className="bg-signal-warning-subtle text-signal-warning border-signal-warning-border">Manual / import only</Badge>
        ) : (
          <Badge variant="secondary">Planned</Badge>
        )}

        {app.scopes && app.scopes.length > 0 && (
          <p className="text-xs text-muted-foreground">Scopes: {app.scopes.slice(0, 5).join(", ")}{app.scopes.length > 5 ? "…" : ""}</p>
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
  const [_profile, setProfile] = useState<UserSettings | null>(null);
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

  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const [deleteText, setDeleteText] = useState("");
  const [deleting, setDeleting] = useState(false);

  // Read ?tab= from URL to support deep links (e.g. ?tab=apps)
  // Map legacy tab names to new names for backwards compat
  const TAB_ALIASES: Record<string, string> = {
    // Legacy tab names → the consolidated tabs, so old ?tab= deep links still resolve.
    setup: "sources",
    readiness: "sources",
    apps: "sources",
    "core-apps": "sources",
    brain: "developer",
    "stig-api": "developer",
    "ai-platforms": "developer",
    advanced: "developer",
  };
  const [activeTab, setActiveTab] = useState<string>("sources");
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
          briefingEmail: draft.briefingEmail,
          briefingSlack: draft.briefingSlack,
          aliasEmails: draft.aliasEmails ?? [],
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

  // The single "Sync now" — pulls the latest from connected sources (Slack sync +
  // poll-ingest + calendar webhook). Deliberately does NOT run the separate
  // "Re-process recent events" reclassification, per the "refresh sources only" intent.
  async function syncNowSources() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await fetch("/api/settings/sync-now", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobs: ["slack", "ingest", "calendar"] }),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        results?: Record<string, { ok?: boolean; messageCount?: number; reason?: string; error?: string }>;
      };
      if (!res.ok || !body.ok) throw new Error("Sync failed");
      const slack = body.results?.slack;
      const bits: string[] = [];
      if (slack?.ok && typeof slack.messageCount === "number") bits.push(`Slack: ${slack.messageCount} messages`);
      else if (slack?.reason === "not_connected") bits.push("Slack not connected");
      bits.push("ingest queued");
      setSyncMsg(`Synced just now · ${bits.join(" · ")}`);
      void loadAll();
    } catch (e) {
      setSyncMsg(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
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
    <div className="wire mx-auto max-w-6xl space-y-6 p-4 pb-10 sm:p-6 lg:p-8">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Settings className="h-6 w-6 text-[var(--w-carbon)]" />
            <h1 className="text-2xl font-semibold tracking-tight">Settings & integrations</h1>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Basil&apos;s control room. Connect the sources that feed the daily briefing, project truth layer and AI command centre.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {statuses !== null && (
            <Badge variant="secondary" className="h-9 px-3 text-sm font-medium">
              <CheckCircle2 className="mr-1.5 h-3.5 w-3.5 text-signal-positive" />{connectedApps} connected
            </Badge>
          )}
          {needsAttention > 0 && (
            <Badge className="h-9 bg-signal-warning-subtle px-3 text-signal-warning border-signal-warning-border font-semibold text-sm">
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
        <div className={`flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm font-medium ${notice.type === "success" ? "border-signal-positive-border bg-signal-positive-subtle text-signal-positive" : "border-signal-critical-border bg-signal-critical-subtle text-signal-critical"}`}>
          {notice.type === "success"
            ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-signal-positive" />
            : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-signal-critical" />}
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
          ? "border-signal-positive-border bg-signal-positive-subtle"
          : isRed
          ? "border-signal-critical-border bg-signal-critical-subtle"
          : "border-signal-warning-border bg-signal-warning-subtle";
        const textClass = isGreen ? "text-signal-positive" : isRed ? "text-signal-critical" : "text-signal-warning";
        const subTextClass = isGreen ? "text-signal-positive" : isRed ? "text-signal-critical" : "text-signal-warning";
        const scoreClass = isGreen ? "text-signal-positive" : isRed ? "text-signal-critical" : "text-signal-warning";
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
              <Icon className={`h-5 w-5 shrink-0 mt-0.5 ${isGreen ? "text-signal-positive" : isRed ? "text-signal-critical" : "text-signal-warning"}`} />
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
          <TabsTrigger value="sources" className="text-xs font-medium">Sources &amp; Sync</TabsTrigger>
          <TabsTrigger value="profile" className="text-xs">Profile</TabsTrigger>
          <TabsTrigger value="security" className="text-xs">Security</TabsTrigger>
          <TabsTrigger value="developer" className="text-xs">Developer</TabsTrigger>
          {/* Legacy deep-link aliases resolve via TAB_ALIASES; hidden triggers keep old ?tab= links valid */}
          <TabsTrigger value="setup" className="hidden" />
          <TabsTrigger value="brain" className="hidden" />
          <TabsTrigger value="apps" className="hidden" />
          <TabsTrigger value="advanced" className="hidden" />
          <TabsTrigger value="readiness" className="hidden" />
          <TabsTrigger value="core-apps" className="hidden" />
          <TabsTrigger value="stig-api" className="hidden" />
          <TabsTrigger value="ai-platforms" className="hidden" />
        </TabsList>

        {/* ── Sources & Sync (merged Setup + Apps; one place, one Sync now) ──── */}
        <TabsContent value="sources" className="mt-6 space-y-6">
          {/* The single Sync now — pulls latest from connected sources */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card/60 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold">Sync now</p>
              <p className="text-xs text-muted-foreground">
                {syncMsg ?? "Pull the latest from your connected sources. Basil also syncs automatically every few minutes."}
              </p>
            </div>
            <Button size="sm" className="gap-1.5 shrink-0" onClick={syncNowSources} disabled={syncing}>
              <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
              {syncing ? "Syncing…" : "Sync now"}
            </Button>
          </div>

          <div>
            <h2 className="text-lg font-semibold">Connected sources</h2>
            <p className="text-sm text-muted-foreground">
              Slack is the operating core. Google (including your email aliases), Calendar, Zoom and Linear enrich the briefing.
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
        </TabsContent>

        {/* ── Profile ───────────────────────────────────────────────────────── */}
        <TabsContent value="profile" className="mt-6">
          <Card className="shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold">Profile & working pattern</CardTitle>
              <p className="text-xs text-muted-foreground">Used in prompts, daily briefing time boundaries and scheduling logic.</p>
            </CardHeader>
            <CardContent className="space-y-4">
              {profileError && <p className="rounded-md bg-signal-critical-subtle px-3 py-2 text-xs text-signal-critical">{profileError}</p>}
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
              <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
                Email aliases
                <Input
                  value={(draft?.aliasEmails ?? []).join(", ")}
                  onChange={(e) => setDraft((d) => d ? { ...d, aliasEmails: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) } : d)}
                  placeholder="you@otherdomain.com, you@alias.io"
                />
                <span className="block text-[11px] font-normal text-muted-foreground/70">
                  Other addresses you own (Gmail aliases / send-as). Basil treats mail from these as you — so it won&apos;t flag a &ldquo;reply to yourself&rdquo; or create a contact for you. Separate multiple with commas.
                </span>
              </label>
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

          <Card className="shadow-sm mt-6">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold">Daily briefing delivery</CardTitle>
              <p className="text-xs text-muted-foreground">Have your morning briefing delivered to you — instead of opening Basil to read it.</p>
            </CardHeader>
            <CardContent className="space-y-3">
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={draft?.briefingEmail ?? true}
                  onChange={(e) => setDraft((d) => d ? { ...d, briefingEmail: e.target.checked } : d)}
                />
                Email me my daily briefing
              </label>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={draft?.briefingSlack ?? false}
                  onChange={(e) => setDraft((d) => d ? { ...d, briefingSlack: e.target.checked } : d)}
                />
                Send my daily briefing as a Slack DM
              </label>
              <Button size="sm" onClick={saveProfile} disabled={savingProfile || !draft}>
                {savingProfile ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                Save delivery preferences
              </Button>
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

        {/* ── Developer (merged Brain + Advanced) — everything technical, out of the way ─ */}
        <TabsContent value="developer" className="mt-6 space-y-6">
          <div>
            <h2 className="text-lg font-semibold">Developer &amp; diagnostics</h2>
            <p className="text-sm text-muted-foreground">Advanced configuration, tooling and diagnostics — you don&apos;t normally need anything here.</p>
          </div>

          {/* Brain — model / API tokens / Siri voice */}
          <StigApiTab status={stigStatus} env={env} copied={copied} setCopied={setCopied} />

          {/* AI platform tracking */}
          <div>
            <h2 className="text-base font-semibold">AI platforms</h2>
            <p className="mb-3 text-sm text-muted-foreground">Track AI tools used in your work. Basil is the source of truth; AI tools are workers.</p>
            <AIPlatformsSection />
          </div>

          {/* Detailed readiness checks */}
          <ReadinessTab />

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

            <Card className="shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold flex items-center gap-2">
                  <Download className="h-4 w-4" />
                  Your data
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Download everything Basil has stored for your account — settings, memory,
                  contacts, actions, decisions and more — as a single JSON file. Keep a copy
                  for your records or for data portability.
                </p>
                <a href="/api/profile/export" download>
                  <Button variant="outline">
                    <Download className="mr-1 h-3.5 w-3.5" />
                    Export my data
                  </Button>
                </a>
              </CardContent>
            </Card>

            <Card className="border-signal-critical-border shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold text-signal-critical flex items-center gap-2">
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
