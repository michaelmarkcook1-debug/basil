/**
 * Microsoft Identity Platform OAuth 2.0 authentication and Graph API helpers.
 *
 * Tokens are persisted per-user via the user store so they survive Vercel cold
 * starts and remain isolated between users.
 *
 * Required env vars:
 *   MICROSOFT_CLIENT_ID
 *   MICROSOFT_CLIENT_SECRET
 *   MICROSOFT_TENANT_ID      (optional, defaults to "common")
 *   MICROSOFT_REDIRECT_URI   (optional — derived from request origin when not set)
 *   NEXT_PUBLIC_APP_URL      (optional fallback when MICROSOFT_REDIRECT_URI is not set)
 */

import { readUserStore, writeUserStore } from "@/lib/storage/user-store";
import type { IntegrationStatus } from "@/lib/integrations/types";

// ── Constants ────────────────────────────────────────────────────────────────

const TOKENS_FILE = "microsoft-tokens.json";

// Teams channel scopes (Team.ReadBasic.All, Channel.ReadBasic.All,
// ChannelMessage.Read.All) require admin consent for Azure AD work accounts.
// We request them here and handle 403 gracefully in the Teams code so that:
//  - Personal Microsoft accounts: granted automatically
//  - Work accounts where the signed-in user IS the tenant admin: granted on consent
//  - Work accounts without admin consent: OAuth succeeds, channel reads return []
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
  "Chat.Read",
  "Chat.ReadBasic",
  "Team.ReadBasic.All",
  "Channel.ReadBasic.All",
  "ChannelMessage.Read.All",
].join(" ");

export const MICROSOFT_SCOPE = {
  mail:            "Mail.Read",
  calendar:        "Calendars.ReadWrite",
  drive:           "Files.Read.All",
  teams:           "Chat.Read",
  teamsChannels:   "Team.ReadBasic.All",
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

function getRedirectUri(appBaseUrl?: string): string {
  // Explicit env var takes top priority
  if (process.env.MICROSOFT_REDIRECT_URI) {
    return process.env.MICROSOFT_REDIRECT_URI;
  }
  // Base URL passed from the incoming request (most reliable on Vercel)
  if (appBaseUrl) {
    return `${appBaseUrl}/api/auth/microsoft/callback`;
  }
  // Fallback: NEXT_PUBLIC_APP_URL (set in Vercel env vars)
  const base = process.env.NEXT_PUBLIC_APP_URL || "";
  return `${base}/api/auth/microsoft/callback`;
}

function getTokenEndpoint(): string {
  return `https://login.microsoftonline.com/${getTenantId()}/oauth2/v2.0/token`;
}

// ── OAuth URL ─────────────────────────────────────────────────────────────────

/**
 * Returns the Microsoft Identity Platform authorization URL.
 * Uses response_mode=query and prompt=consent to always re-confirm scopes.
 *
 * @param appBaseUrl  Optional origin of the app (e.g. "https://basil-app.vercel.app").
 *                    Derived from the incoming request in the auth route handler so
 *                    MICROSOFT_REDIRECT_URI / NEXT_PUBLIC_APP_URL are not required.
 */
export function getMicrosoftAuthUrl(appBaseUrl?: string): string {
  const params = new URLSearchParams({
    client_id:     process.env.MICROSOFT_CLIENT_ID || "",
    response_type: "code",
    response_mode: "query",
    redirect_uri:  getRedirectUri(appBaseUrl),
    scope:         SCOPES,
    prompt:        "consent",
  });
  return `https://login.microsoftonline.com/${getTenantId()}/oauth2/v2.0/authorize?${params}`;
}

// ── Token exchange ────────────────────────────────────────────────────────────

/**
 * Exchange an OAuth authorization code for tokens and persist them to the
 * user's scoped store so they survive Vercel cold starts.
 *
 * @param code        The authorization code from the OAuth callback.
 * @param username    The logged-in user to store tokens for.
 * @param appBaseUrl  Same origin passed to getMicrosoftAuthUrl() so both ends
 *                    of the OAuth flow use an identical redirect_uri.
 */
export async function exchangeCode(code: string, username: string, appBaseUrl?: string): Promise<MicrosoftTokens> {
  const res = await fetch(getTokenEndpoint(), {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({
      client_id:     process.env.MICROSOFT_CLIENT_ID || "",
      client_secret: process.env.MICROSOFT_CLIENT_SECRET || "",
      code,
      redirect_uri:  getRedirectUri(appBaseUrl),
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

  await writeUserStore<MicrosoftTokens>(username, TOKENS_FILE, tokens);
  return tokens;
}

// ── Token persistence ─────────────────────────────────────────────────────────

/**
 * Read stored Microsoft OAuth tokens for a specific user.
 * Strictly user-scoped — no global fallback to prevent data bleed across users.
 */
export async function getStoredTokens(username: string): Promise<MicrosoftTokens | null> {
  const fromUserStore = await readUserStore<MicrosoftTokens | null>(username, TOKENS_FILE, null);
  if (fromUserStore?.access_token) return fromUserStore;
  return null;
}

// ── Access token (auto-refresh) ───────────────────────────────────────────────

/**
 * Returns a valid access token for the user, refreshing automatically if within
 * 5 minutes of expiry. Returns null if no tokens are stored or refresh fails.
 */
export async function getAccessToken(username: string): Promise<string | null> {
  const tokens = await getStoredTokens(username);
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

    await writeUserStore<MicrosoftTokens>(username, TOKENS_FILE, refreshed);
    return refreshed.access_token;
  } catch (err) {
    console.error("[microsoft-auth] Token refresh error:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Graph fetch helpers ───────────────────────────────────────────────────────

/**
 * Unconditionally refresh the access token using the stored refresh_token,
 * bypassing the cached `expires_at` check.  Called on 401 responses to recover
 * from server-side token invalidation (password change, conditional access,
 * admin revoke) that makes a locally-valid-looking token rejected by Graph.
 *
 * On refresh failure: writes `expires_at: 0` so that the next
 * `getMicrosoftConnectionStatus` call returns `token_expired` and the Settings
 * page prompts the user to re-authorise.
 */
async function forceRefreshToken(username: string): Promise<string | null> {
  const tokens = await getStoredTokens(username);
  if (!tokens?.refresh_token) return null;

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
      console.error(`[microsoft-auth] Force-refresh failed HTTP ${res.status}: ${body.slice(0, 200)}`);
      // Mark token as expired so status page shows "re-authorize" prompt
      await writeUserStore<MicrosoftTokens>(username, TOKENS_FILE, {
        ...tokens,
        access_token: "",
        expires_at:   0,
      });
      return null;
    }

    const data = await res.json() as {
      access_token:   string;
      refresh_token?: string;
      expires_in:     number;
      scope:          string;
      token_type:     string;
    };

    const refreshed: MicrosoftTokens = {
      access_token:  data.access_token,
      refresh_token: data.refresh_token || tokens.refresh_token,
      expires_at:    Date.now() + data.expires_in * 1000,
      scope:         data.scope || tokens.scope,
      token_type:    data.token_type,
    };

    await writeUserStore<MicrosoftTokens>(username, TOKENS_FILE, refreshed);
    console.log("[microsoft-auth] Force-refresh succeeded — new token stored");
    return refreshed.access_token;
  } catch (err) {
    console.error("[microsoft-auth] Force-refresh error:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Low-level fetch against Microsoft Graph with Authorization header injected.
 * If path starts with "https://" it is used as-is; otherwise GRAPH_BASE is prepended.
 * Returns null if not authenticated.
 *
 * Handles 401 responses automatically: attempts a forced token refresh and
 * retries once.  This recovers from server-side invalidation (password changes,
 * conditional access, admin revoke) where the locally-cached token looks valid
 * but is rejected by Graph.  If the retry also fails, returns the 401 response
 * to the caller so it can log/surface the error.
 */
export async function graphFetch(
  username: string,
  path: string,
  options: RequestInit = {}
): Promise<Response | null> {
  const token = await getAccessToken(username);
  if (!token) return null;

  const url = path.startsWith("https://") ? path : `${GRAPH_BASE}${path}`;

  const buildHeaders = (t: string): Headers => {
    const h = new Headers(options.headers ?? {});
    h.set("Authorization", `Bearer ${t}`);
    if (!h.has("Content-Type") && options.method && options.method !== "GET") {
      h.set("Content-Type", "application/json");
    }
    return h;
  };

  const res = await fetch(url, { ...options, headers: buildHeaders(token) });

  // On 401: locally-cached token may be server-side invalidated.
  // Force-refresh using refresh_token and retry once.
  if (res.status === 401) {
    console.warn(`[microsoft-auth] 401 on ${path} — attempting force-refresh`);
    const freshToken = await forceRefreshToken(username);
    if (!freshToken) return res; // refresh failed — caller gets the 401
    return fetch(url, { ...options, headers: buildHeaders(freshToken) });
  }

  return res;
}

/**
 * GET convenience wrapper.  Returns null if not authenticated.
 * Throws a descriptive error on non-2xx HTTP responses.
 */
export async function graphGet<T>(username: string, path: string): Promise<T | null> {
  const res = await graphFetch(username, path, { method: "GET" });
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
export async function getMicrosoftConnectionStatus(username: string): Promise<IntegrationStatus> {
  const now = new Date().toISOString();
  try {
    // Step 1: check whether tokens are stored at all.
    const tokens = await getStoredTokens(username);
    if (!tokens?.access_token) {
      return { id: "microsoft", state: "disconnected", lastCheckedAt: now };
    }

    // Step 2: verify we can get a live, valid access token (auto-refreshes if
    // near expiry). If this returns null the stored tokens are unusable —
    // either the refresh token is invalid or MICROSOFT_CLIENT_SECRET is wrong.
    // This is the check that prevents false-positive "connected" badges.
    const liveToken = await getAccessToken(username);
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

    // Core services (mail + calendar) are sufficient for "connected".
    // Drive and Teams are optional — their individual tiles show their own
    // status. Only fall to permission_missing if the core is absent.
    const coreGranted = hasMail && hasCalendar;

    return {
      id:            "microsoft",
      state:         coreGranted ? "connected" : "permission_missing",
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
