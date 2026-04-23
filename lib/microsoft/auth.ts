/**
 * Microsoft Identity Platform OAuth 2.0 authentication and Graph API helpers.
 *
 * Tokens are persisted via the shared store so they survive Vercel cold starts
 * (included in the BASIL_DATA snapshot automatically by writeStore → persistSnapshot).
 *
 * Required env vars:
 *   MICROSOFT_CLIENT_ID
 *   MICROSOFT_CLIENT_SECRET
 *   MICROSOFT_TENANT_ID      (optional, defaults to "common")
 *   MICROSOFT_REDIRECT_URI   (optional, defaults to ${NEXT_PUBLIC_APP_URL}/api/auth/microsoft/callback)
 */

import { readStore, writeStore } from "@/lib/storage/persistent";
import type { IntegrationStatus } from "@/lib/integrations/types";

// ── Constants ────────────────────────────────────────────────────────────────

const TOKENS_FILE = "microsoft-tokens.json";

const SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "Mail.Read",
  "Mail.ReadWrite",
  "Mail.Send",
  "Calendars.ReadWrite",
  "Files.Read.All",
  "Team.ReadBasic.All",
  "Channel.ReadBasic.All",
  "ChannelMessage.Read.All",
  "Chat.Read",
  "Chat.ReadBasic",
].join(" ");

export const MICROSOFT_SCOPE = {
  mail:      "Mail.Read",
  calendar:  "Calendars.ReadWrite",
  drive:     "Files.Read.All",
  teams:     "Chat.Read",
} as const;

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

// ── Types ────────────────────────────────────────────────────────────────────

export type MicrosoftTokens = {
  access_token:   string;
  refresh_token?: string;
  expires_at:     number; // epoch ms
  scope:          string;
  token_type:     string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function getTenantId(): string {
  return process.env.MICROSOFT_TENANT_ID || "common";
}

function getRedirectUri(): string {
  return (
    process.env.MICROSOFT_REDIRECT_URI ||
    `${process.env.NEXT_PUBLIC_APP_URL || ""}/api/auth/microsoft/callback`
  );
}

function getTokenEndpoint(): string {
  return `https://login.microsoftonline.com/${getTenantId()}/oauth2/v2.0/token`;
}

// ── OAuth URL ─────────────────────────────────────────────────────────────────

/**
 * Returns the Microsoft Identity Platform authorization URL.
 * Uses response_mode=query and prompt=consent to always re-confirm scopes.
 */
export function getMicrosoftAuthUrl(): string {
  const params = new URLSearchParams({
    client_id:     process.env.MICROSOFT_CLIENT_ID || "",
    response_type: "code",
    response_mode: "query",
    redirect_uri:  getRedirectUri(),
    scope:         SCOPES,
    prompt:        "consent",
  });
  return `https://login.microsoftonline.com/${getTenantId()}/oauth2/v2.0/authorize?${params}`;
}

// ── Token exchange ────────────────────────────────────────────────────────────

/**
 * Exchange an OAuth authorization code for tokens and persist them via the
 * shared store so they survive Vercel cold starts.
 */
export async function exchangeCode(code: string): Promise<MicrosoftTokens> {
  const res = await fetch(getTokenEndpoint(), {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({
      client_id:     process.env.MICROSOFT_CLIENT_ID || "",
      client_secret: process.env.MICROSOFT_CLIENT_SECRET || "",
      code,
      redirect_uri:  getRedirectUri(),
      grant_type:    "authorization_code",
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Microsoft token exchange failed HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json() as {
    access_token:  string;
    refresh_token?: string;
    expires_in:    number;
    scope:         string;
    token_type:    string;
  };

  const tokens: MicrosoftTokens = {
    access_token:   data.access_token,
    refresh_token:  data.refresh_token,
    expires_at:     Date.now() + data.expires_in * 1000,
    scope:          data.scope,
    token_type:     data.token_type,
  };

  await writeStore<MicrosoftTokens>(TOKENS_FILE, tokens);
  return tokens;
}

// ── Token persistence ─────────────────────────────────────────────────────────

/**
 * Read stored Microsoft OAuth tokens.
 * readStore calls maybeRestore() internally, so cold-start tokens are
 * hydrated from BASIL_DATA before the file read happens.
 */
export async function getStoredTokens(): Promise<MicrosoftTokens | null> {
  const fromStore = await readStore<MicrosoftTokens | null>(TOKENS_FILE, null);
  if (fromStore?.access_token) return fromStore;
  return null;
}

// ── Access token (auto-refresh) ───────────────────────────────────────────────

/**
 * Returns a valid access token, refreshing automatically if within 5 minutes
 * of expiry. Returns null if no tokens are stored or refresh fails.
 */
export async function getAccessToken(): Promise<string | null> {
  const tokens = await getStoredTokens();
  if (!tokens) return null;

  // Still valid — not within 5-minute expiry window
  if (tokens.expires_at > Date.now() + 5 * 60 * 1000) {
    return tokens.access_token;
  }

  // No refresh token — cannot renew
  if (!tokens.refresh_token) return null;

  try {
    const res = await fetch(getTokenEndpoint(), {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    new URLSearchParams({
        client_id:     process.env.MICROSOFT_CLIENT_ID || "",
        client_secret: process.env.MICROSOFT_CLIENT_SECRET || "",
        refresh_token: tokens.refresh_token,
        grant_type:    "refresh_token",
        scope:         SCOPES,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[microsoft-auth] Token refresh failed HTTP ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const data = await res.json() as {
      access_token:  string;
      refresh_token?: string;
      expires_in:    number;
      scope:         string;
      token_type:    string;
    };

    const refreshed: MicrosoftTokens = {
      access_token:  data.access_token,
      refresh_token: data.refresh_token || tokens.refresh_token,
      expires_at:    Date.now() + data.expires_in * 1000,
      scope:         data.scope || tokens.scope,
      token_type:    data.token_type,
    };

    await writeStore<MicrosoftTokens>(TOKENS_FILE, refreshed);
    return refreshed.access_token;
  } catch (err) {
    console.error("[microsoft-auth] Token refresh error:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Graph fetch helpers ───────────────────────────────────────────────────────

/**
 * Low-level fetch against Microsoft Graph with Authorization header injected.
 * If path starts with "https://" it is used as-is; otherwise GRAPH_BASE is prepended.
 * Returns null if not authenticated.
 */
export async function graphFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response | null> {
  const token = await getAccessToken();
  if (!token) return null;

  const url = path.startsWith("https://") ? path : `${GRAPH_BASE}${path}`;

  const headers = new Headers(options.headers ?? {});
  headers.set("Authorization", `Bearer ${token}`);
  if (!headers.has("Content-Type") && options.method && options.method !== "GET") {
    headers.set("Content-Type", "application/json");
  }

  return fetch(url, { ...options, headers });
}

/**
 * GET convenience wrapper.  Returns null if not authenticated.
 * Throws a descriptive error on non-2xx HTTP responses.
 */
export async function graphGet<T>(path: string): Promise<T | null> {
  const res = await graphFetch(path, { method: "GET" });
  if (res === null) return null;

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Graph GET ${path} → HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  return res.json() as Promise<T>;
}

// ── Connection status ─────────────────────────────────────────────────────────

/**
 * Returns a normalized IntegrationStatus for Microsoft 365.
 * Never throws — always resolves to a concrete state.
 */
export async function getMicrosoftConnectionStatus(): Promise<IntegrationStatus> {
  const now = new Date().toISOString();
  try {
    // Step 1: check whether tokens are stored at all.
    const tokens = await getStoredTokens();
    if (!tokens?.access_token) {
      return { id: "microsoft", state: "disconnected", lastCheckedAt: now };
    }

    // Step 2: verify we can get a live, valid access token (auto-refreshes if
    // near expiry). If this returns null the stored tokens are unusable —
    // either the refresh token is invalid or MICROSOFT_CLIENT_SECRET is wrong.
    // This is the check that prevents false-positive "connected" badges.
    const liveToken = await getAccessToken();
    if (!liveToken) {
      return {
        id:            "microsoft",
        state:         "token_expired",
        lastCheckedAt: now,
        error:         "Token could not be refreshed — please re-authorize.",
      };
    }

    // Step 3: derive per-scope flags from the stored scope string (no extra
    // API call needed — the scope was persisted at auth time).
    const granted = new Set(
      tokens.scope?.split(/[\s,]+/).filter(Boolean) ?? []
    );

    const hasMail     = granted.has(MICROSOFT_SCOPE.mail);
    const hasCalendar = granted.has(MICROSOFT_SCOPE.calendar);
    const hasDrive    = granted.has(MICROSOFT_SCOPE.drive);
    const hasTeams    = granted.has(MICROSOFT_SCOPE.teams);
    const allGranted  = hasMail && hasCalendar && hasDrive && hasTeams;

    return {
      id:            "microsoft",
      state:         allGranted ? "connected" : "permission_missing",
      lastCheckedAt: now,
      scopes:        [...granted],
      microsoft: {
        mail:     hasMail,
        calendar: hasCalendar,
        drive:    hasDrive,
        teams:    hasTeams,
      },
    } as IntegrationStatus & {
      microsoft: { mail: boolean; calendar: boolean; drive: boolean; teams: boolean };
    };
  } catch (err) {
    return {
      id:            "microsoft",
      state:         "error",
      lastCheckedAt: now,
      error:         err instanceof Error ? err.message : String(err),
    };
  }
}
