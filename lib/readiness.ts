/**
 * Shared server-side readiness utility for Basil.
 * Called by /api/readiness and the dashboard readiness card.
 */

import { isSlackConnected } from "@/lib/slack/client";
import { getGoogleConnectionStatus } from "@/lib/google/auth";

export interface ReadinessCheck {
  id: string;
  label: string;
  ok: boolean;
  severity: "blocker" | "warning" | "info";
  detail: string;
  action: string;
}

export interface ReadinessReport {
  checks: ReadinessCheck[];
  blockers: ReadinessCheck[];
  score: number; // 0–100
}

export async function getReadiness(username: string): Promise<ReadinessReport> {
  const checks: ReadinessCheck[] = [];

  // 1. Encryption key — blocker
  const encryptionKeyOk = !!process.env.BASIL_TOKEN_ENCRYPTION_KEY;
  checks.push({
    id: "encryption_key",
    label: "Token encryption key",
    ok: encryptionKeyOk,
    severity: "blocker",
    detail: encryptionKeyOk
      ? "BASIL_TOKEN_ENCRYPTION_KEY is set — credentials are stored securely."
      : "BASIL_TOKEN_ENCRYPTION_KEY is missing — credentials cannot be saved securely.",
    action: "Set BASIL_TOKEN_ENCRYPTION_KEY in Vercel env vars",
  });

  // 2. Model config — blocker (Anthropic, OpenAI, Vercel Gateway, or Basil LLM key)
  const hasAnthropic = !!(process.env.ANTHROPIC_API_KEY ?? process.env.BASIL_LLM_KEY);
  const hasOpenAI = !!(process.env.openai_basilv2 ?? process.env.OPENAI_API_KEY);
  const hasGateway = !!(process.env.VERCEL_OIDC_TOKEN ?? process.env.AI_GATEWAY_API_KEY);
  const modelConfigOk = hasAnthropic || hasOpenAI || hasGateway;
  const modelDetail = hasAnthropic
    ? "ANTHROPIC_API_KEY is set — Anthropic Claude is ready."
    : hasOpenAI
    ? `OPENAI_API_KEY is set — OpenAI direct is ready (model: ${process.env.OPENAI_MODEL ?? "gpt-4o"}).`
    : hasGateway
    ? "VERCEL_OIDC_TOKEN is set — Vercel AI Gateway is ready."
    : "No AI provider key is set — Chat and briefings will not work.";
  const modelAction = modelConfigOk
    ? ""
    : "Add ANTHROPIC_API_KEY (or OPENAI_API_KEY) in Vercel env vars.";
  checks.push({
    id: "model_config",
    label: "AI brain",
    ok: modelConfigOk,
    severity: "blocker",
    detail: modelDetail,
    action: modelAction,
  });

  // 3. Slack — warning
  let slackOk = false;
  try {
    slackOk = await isSlackConnected(username);
  } catch {
    slackOk = false;
  }
  checks.push({
    id: "slack",
    label: "Slack",
    ok: slackOk,
    severity: "warning",
    detail: slackOk
      ? "Slack is connected."
      : "Slack is not connected — briefings will lack team signal.",
    action: "Connect Slack in Settings → Core Apps",
  });

  // 4. Google — warning
  let googleOk = false;
  try {
    const googleStatus = await getGoogleConnectionStatus(username);
    googleOk = googleStatus.state === "connected";
  } catch {
    googleOk = false;
  }
  checks.push({
    id: "google",
    label: "Google Workspace",
    ok: googleOk,
    severity: "warning",
    detail: googleOk
      ? "Google Workspace is connected."
      : "Google Workspace is not connected — calendar, email, and Drive unavailable.",
    action: "Connect Google in Settings → Core Apps",
  });

  // 5. STIG API token — info only (optional; only needed for Siri / external API callers)
  // NOTE: The Stig brain inside the web app authenticates via session cookie — this
  // token is only required for Siri Shortcuts, mobile apps, or external API calls.
  // Leaving it unset does NOT break Chat, Briefing, or any in-browser functionality.
  const stigTokenOk = !!process.env.STIG_API_TOKEN;
  checks.push({
    id: "stig_token",
    label: "Siri / External API token (optional)",
    ok: true, // never a blocker — absence is fine for web-only use
    severity: "info",
    detail: stigTokenOk
      ? "STIG_API_TOKEN is set — Siri and external API callers can authenticate."
      : "STIG_API_TOKEN is not set. This is optional — it only affects Siri Shortcuts and external API access. Chat, Briefing, and all in-browser features work without it.",
    action: stigTokenOk ? "" : "Set STIG_API_TOKEN only if you need Siri or external API access",
  });

  // 6. Admin username — warning
  const adminUsernameOk = !!process.env.ADMIN_USERNAME;
  checks.push({
    id: "admin_username",
    label: "Admin username",
    ok: adminUsernameOk,
    severity: "warning",
    detail: adminUsernameOk
      ? "ADMIN_USERNAME is set."
      : "ADMIN_USERNAME is not set — admin features may be limited.",
    action: "Set ADMIN_USERNAME in env vars",
  });

  const passing = checks.filter((c) => c.ok).length;
  const score = Math.round((passing / checks.length) * 100);
  const blockers = checks.filter((c) => !c.ok && c.severity === "blocker");

  return { checks, blockers, score };
}
