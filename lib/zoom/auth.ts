import { getIntegrationToken, saveIntegrationToken, deleteIntegrationToken } from "@/lib/storage/secure-token-store";
import { forceFlushSnapshot } from "@/lib/storage/persistent";
import type { IntegrationStatus } from "@/lib/integrations/types";

// ── Types ────────────────────────────────────────────────────────────────────

export type ZoomTokens = {
  access_token:  string;
  refresh_token: string;
  expires_at:    number; // epoch ms
  scope:         string;
  token_type:    string;
};

// ── Auth URL ─────────────────────────────────────────────────────────────────

export function getZoomAuthUrl(): string {
  const clientId    = process.env.ZOOM_CLIENT_ID    ?? "";
  const redirectUri = process.env.ZOOM_REDIRECT_URI ?? "";
  return `https://zoom.us/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
}

// ── Token exchange ────────────────────────────────────────────────────────────

export async function exchangeZoomCode(code: string, username: string): Promise<ZoomTokens> {
  const clientId     = process.env.ZOOM_CLIENT_ID     ?? "";
  const clientSecret = process.env.ZOOM_CLIENT_SECRET ?? "";
  const redirectUri  = process.env.ZOOM_REDIRECT_URI  ?? "";

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const body = new URLSearchParams({
    grant_type:   "authorization_code",
    code,
    redirect_uri: redirectUri,
  });

  const res = await fetch("https://zoom.us/oauth/token", {
    method:  "POST",
    headers: {
      "Authorization": `Basic ${basicAuth}`,
      "Content-Type":  "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Zoom token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json() as {
    access_token:  string;
    refresh_token: string;
    expires_in:    number;
    scope:         string;
    token_type:    string;
  };

  const tokens: ZoomTokens = {
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expires_at:    Date.now() + data.expires_in * 1000,
    scope:         data.scope,
    token_type:    data.token_type,
  };

  await saveIntegrationToken(username, "zoom", tokens);
  return tokens;
}

// ── Token persistence ─────────────────────────────────────────────────────────

export async function getZoomTokens(username: string): Promise<ZoomTokens | null> {
  return getIntegrationToken<ZoomTokens>(username, "zoom");
}

// ── Connection status ─────────────────────────────────────────────────────────

export async function isZoomConnected(username: string): Promise<boolean> {
  const tokens = await getZoomTokens(username);
  if (!tokens?.refresh_token) return false;
  // Consider connected as long as a refresh token exists
  return true;
}

// ── Token refresh ─────────────────────────────────────────────────────────────

export async function refreshZoomTokens(username: string): Promise<ZoomTokens | null> {
  const tokens = await getZoomTokens(username);
  if (!tokens?.refresh_token) return null;

  const clientId     = process.env.ZOOM_CLIENT_ID     ?? "";
  const clientSecret = process.env.ZOOM_CLIENT_SECRET ?? "";
  const basicAuth    = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const body = new URLSearchParams({
    grant_type:    "refresh_token",
    refresh_token: tokens.refresh_token,
  });

  const res = await fetch("https://zoom.us/oauth/token", {
    method:  "POST",
    headers: {
      "Authorization": `Basic ${basicAuth}`,
      "Content-Type":  "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!res.ok) return null;

  const data = await res.json() as {
    access_token:  string;
    refresh_token: string;
    expires_in:    number;
    scope:         string;
    token_type:    string;
  };

  const updated: ZoomTokens = {
    access_token:  data.access_token,
    refresh_token: data.refresh_token ?? tokens.refresh_token,
    expires_at:    Date.now() + data.expires_in * 1000,
    scope:         data.scope,
    token_type:    data.token_type,
  };

  await saveIntegrationToken(username, "zoom", updated);
  return updated;
}

// ── Valid access token (auto-refresh) ────────────────────────────────────────

export async function getValidZoomAccessToken(username: string): Promise<string | null> {
  let tokens = await getZoomTokens(username);
  if (!tokens?.refresh_token) return null;

  // If access token is still fresh (5-min buffer), return it directly
  const stillFresh = tokens.access_token && tokens.expires_at > Date.now() + 5 * 60 * 1000;
  if (stillFresh) return tokens.access_token;

  // Otherwise attempt refresh
  tokens = await refreshZoomTokens(username);
  return tokens?.access_token ?? null;
}

// ── IntegrationStatus ─────────────────────────────────────────────────────────

export async function getZoomConnectionStatus(username: string): Promise<IntegrationStatus> {
  const now       = new Date().toISOString();
  const connected = await isZoomConnected(username);
  return {
    id:            "zoom",
    state:         connected ? "connected" : "disconnected",
    lastCheckedAt: now,
  };
}

// ── Disconnect ────────────────────────────────────────────────────────────────

export async function disconnectZoom(username: string): Promise<void> {
  await deleteIntegrationToken(username, "zoom");
  await forceFlushSnapshot();
}
