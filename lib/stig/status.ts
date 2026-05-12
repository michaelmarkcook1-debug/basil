import "server-only";

import { getGoogleConnectionStatus } from "@/lib/google/auth";
import { getMicrosoftConnectionStatus } from "@/lib/microsoft/auth";
import { isSlackConnected } from "@/lib/slack/client";
import { isLinearConnected } from "@/lib/linear/client";
import { isZoomConnected } from "@/lib/zoom/auth";
import { getAIPlatformStatus } from "@/lib/ai-platforms/credentials";
import { buildProjectTruth } from "@/lib/projects/truth";
import { GATEWAY_MODEL_IDS, PROVIDER_MODE } from "@/lib/ai/model-config";

async function settled<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise;
  } catch {
    return fallback;
  }
}

export async function buildStigStatus(username: string) {
  const now = new Date().toISOString();

  const [
    google,
    microsoft,
    slack,
    linear,
    zoom,
    openai,
    anthropic,
    gemini,
    github,
    projects,
  ] = await Promise.all([
    settled(getGoogleConnectionStatus(username), { id: "google", state: "error", lastCheckedAt: now, error: "status check failed" }),
    settled(getMicrosoftConnectionStatus(username), { id: "microsoft", state: "error", lastCheckedAt: now, error: "status check failed" }),
    settled(isSlackConnected(username), false),
    settled(isLinearConnected(username), false),
    settled(isZoomConnected(username), false),
    settled(getAIPlatformStatus(username, "openai"), { id: "openai", state: "error", lastCheckedAt: now, error: "status check failed" }),
    settled(getAIPlatformStatus(username, "anthropic"), { id: "anthropic", state: "error", lastCheckedAt: now, error: "status check failed" }),
    settled(getAIPlatformStatus(username, "gemini"), { id: "gemini", state: "error", lastCheckedAt: now, error: "status check failed" }),
    settled(getAIPlatformStatus(username, "github"), { id: "github", state: "error", lastCheckedAt: now, error: "status check failed" }),
    settled(buildProjectTruth(username), null),
  ]);

  return {
    ok: true,
    embedded: true,
    name: "The Stig API",
    generatedAt: now,
    model: {
      providerMode: PROVIDER_MODE,
      fast:         GATEWAY_MODEL_IDS.fast,
      default:      GATEWAY_MODEL_IDS.default,
      long:         GATEWAY_MODEL_IDS.long,
      gatewayReady: Boolean(process.env.VERCEL_OIDC_TOKEN || process.env.AI_GATEWAY_API_KEY),
    },
    auth: {
      session: true,
      tokenAuthConfigured: Boolean(process.env.STIG_API_TOKEN && (process.env.STIG_API_USERNAME || process.env.PRIMARY_OWNER_USERNAME || process.env.ADMIN_USERNAME)),
    },
    endpoints: {
      status: "/api/stig/status",
      ask: "/api/stig/ask",
      siri: "/api/stig/siri",
      briefing: "/api/stig/briefing",
      projects: "/api/projects",
      slackCommand: "/api/slack/command",
    },
    appSources: {
      slack: { id: "slack", state: slack ? "connected" : "disconnected", lastCheckedAt: now },
      google,
      microsoft,
      linear: { id: "linear", state: linear ? "connected" : "disconnected", lastCheckedAt: now },
      zoom: { id: "zoom", state: zoom ? "connected" : "disconnected", lastCheckedAt: now },
    },
    aiSources: {
      openai,
      anthropic,
      gemini,
      github,
    },
    projectTruth: projects ? {
      projects: projects.projects.length,
      blocked: projects.projects.filter((p) => p.status === "blocked").length,
      aiWork: projects.projects.reduce((sum, p) => sum + p.aiWorkCount, 0),
      sourceCounts: projects.sourceCounts,
    } : null,
  };
}
