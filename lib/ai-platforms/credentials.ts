import "server-only";

import { getIntegrationToken, saveIntegrationToken, deleteIntegrationToken } from "@/lib/storage/secure-token-store";
import type { IntegrationStatus } from "@/lib/integrations/types";
import type { SupportedProvider } from "@/lib/storage/secure-token-store";
import { getSettings, patchSettings } from "@/lib/settings/store";

export type AIKeyPlatform = "github" | "openai" | "anthropic" | "gemini";

export interface AIPlatformSecret {
  apiKey: string;
  connectedAt: string;
  label?: string;
}

const LEGACY_FIELD: Record<AIKeyPlatform, "githubToken" | "openaiApiKey" | "anthropicApiKey" | "geminiApiKey"> = {
  github: "githubToken",
  openai: "openaiApiKey",
  anthropic: "anthropicApiKey",
  gemini: "geminiApiKey",
};

function providerFor(platform: AIKeyPlatform): SupportedProvider {
  return platform;
}

function redactError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/sk-[A-Za-z0-9_-]+/g, "sk-***").replace(/gh[pousr]_[A-Za-z0-9_]+/g, "gh***");
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(12_000) });
  const bodyText = await res.text().catch((err) => {
    console.error("[ai-platforms] response body read failed:", err instanceof Error ? err.message : String(err));
    return "";
  });
  let body: unknown = {};
  if (bodyText) {
    try {
      body = JSON.parse(bodyText);
    } catch (err) {
      console.error("[ai-platforms] non-json response:", err instanceof Error ? err.message : String(err));
      body = { text: bodyText.slice(0, 300) };
    }
  }
  if (!res.ok) {
    const detail = typeof body === "object" && body !== null && "error" in body
      ? JSON.stringify((body as Record<string, unknown>).error).slice(0, 300)
      : bodyText.slice(0, 300);
    throw new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
  }
  return body;
}

export async function validateAIPlatformKey(platform: AIKeyPlatform, apiKey: string): Promise<string> {
  const key = apiKey.trim();
  if (!key) throw new Error("API key is required");

  if (platform === "github") {
    const data = await fetchJson("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "basil-executive-os",
      },
    }) as { login?: string; name?: string };
    return data.name || data.login || "GitHub account";
  }

  if (platform === "openai") {
    const data = await fetchJson("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
    }) as { data?: Array<{ id?: string }> };
    const count = Array.isArray(data.data) ? data.data.length : 0;
    return `${count} model${count === 1 ? "" : "s"} available`;
  }

  if (platform === "anthropic") {
    const data = await fetchJson("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
    }) as { data?: Array<{ id?: string }> };
    const count = Array.isArray(data.data) ? data.data.length : 0;
    return `${count} Claude model${count === 1 ? "" : "s"} available`;
  }

  if (platform === "gemini") {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
    const data = await fetchJson(url, {}) as { models?: Array<{ name?: string }> };
    const count = Array.isArray(data.models) ? data.models.length : 0;
    return `${count} Gemini model${count === 1 ? "" : "s"} available`;
  }

  throw new Error(`Unsupported platform: ${platform}`);
}

export async function getAIPlatformKey(username: string, platform: AIKeyPlatform): Promise<string | null> {
  const stored = await getIntegrationToken<AIPlatformSecret>(username, providerFor(platform));
  if (stored?.apiKey) return stored.apiKey;

  // Backward-compatible migration from the old settings store fields.
  const settings = await getSettings(username);
  const legacyKey = settings[LEGACY_FIELD[platform]];
  if (typeof legacyKey === "string" && legacyKey.trim()) {
    try {
      await saveAIPlatformKey(username, platform, legacyKey.trim(), "Migrated legacy key");
      await patchSettings(username, { [LEGACY_FIELD[platform]]: "" });
    } catch (err) {
      console.error("[ai-platforms] legacy key migration failed:", redactError(err));
    }
    return legacyKey.trim();
  }

  return null;
}

export async function saveAIPlatformKey(
  username: string,
  platform: AIKeyPlatform,
  apiKey: string,
  label?: string
): Promise<void> {
  await saveIntegrationToken(username, providerFor(platform), {
    apiKey: apiKey.trim(),
    connectedAt: new Date().toISOString(),
    label,
  } satisfies AIPlatformSecret);
}

export async function deleteAIPlatformKey(username: string, platform: AIKeyPlatform): Promise<void> {
  await deleteIntegrationToken(username, providerFor(platform));
  // Also clear legacy field if present.
  await patchSettings(username, { [LEGACY_FIELD[platform]]: "" });
}

export async function getAIPlatformStatus(username: string, platform: AIKeyPlatform): Promise<IntegrationStatus & { label?: string }> {
  const now = new Date().toISOString();
  try {
    const stored = await getIntegrationToken<AIPlatformSecret>(username, providerFor(platform));
    if (stored?.apiKey) {
      return {
        id: platform,
        state: "connected",
        lastCheckedAt: now,
        lastSyncedAt: stored.connectedAt,
        label: stored.label,
      };
    }

    const settings = await getSettings(username);
    const legacyKey = settings[LEGACY_FIELD[platform]];
    if (typeof legacyKey === "string" && legacyKey.trim()) {
      return {
        id: platform,
        state: "connected",
        lastCheckedAt: now,
        error: "Stored in legacy settings. Reconnect once to move this into encrypted token storage.",
      };
    }

    return { id: platform, state: "disconnected", lastCheckedAt: now };
  } catch (err) {
    return { id: platform, state: "error", lastCheckedAt: now, error: redactError(err) };
  }
}
