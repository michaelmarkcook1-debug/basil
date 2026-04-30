import { google } from "googleapis";
import { readUserStore, writeUserStore } from "@/lib/storage/user-store";
import type { IntegrationStatus } from "@/lib/integrations/types";

// ── Constants ────────────────────────────────────────────────────────────────

const TOKENS_FILE = "google-tokens.json";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/drive.readonly",
];

export const GOOGLE_SCOPE = {
  calendar: "https://www.googleapis.com/auth/calendar",
  gmail:    "https://www.googleapis.com/auth/gmail.modify",
  drive:    "https://www.googleapis.com/auth/drive.readonly",
} as const;

export type GoogleTokens = {
  access_token?:  string;
  refresh_token?: string;
  expiry_date?:   number; // epoch ms
  scope?:         string;
  token_type?:    string;
};

// ── OAuth client factory ─────────────────────────────────────────────────────

export function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

export function getAuthUrl(): string {
  const client = getOAuth2Client();
  return client.generateAuthUrl({
    access_type: "offline",
    scope:       SCOPES,
    prompt:      "consent",
  });
}

// ── Token persistence ────────────────────────────────────────────────────────

/**
 * Exchange an OAuth authorization code for tokens and persist them to the
 * user's scoped store so they survive Vercel cold starts.
 */
export async function exchangeCode(code: string, username: string): Promise<GoogleTokens> {
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(code);
  await writeUserStore<GoogleTokens>(username, TOKENS_FILE, tokens as GoogleTokens);
  return tokens as GoogleTokens;
}

/**
 * Read stored Google OAuth tokens for a specific user.
 * Strictly user-scoped — no global fallback to prevent data bleed across users.
 */
export async function getStoredTokens(username: string): Promise<GoogleTokens | null> {
  const fromUserStore = await readUserStore<GoogleTokens | null>(username, TOKENS_FILE, null);
  if (fromUserStore?.refresh_token) return fromUserStore;
  return null;
}

// ── Scope helpers ─────────────────────────────────────────────────────────────

/** Returns the list of OAuth scopes granted by the user. Empty if no token. */
export async function getGrantedScopes(username: string): Promise<string[]> {
  const tokens = await getStoredTokens(username);
  if (!tokens?.scope || typeof tokens.scope !== "string") return [];
  return tokens.scope.split(/\s+/).filter(Boolean);
}

// ── Connection status ─────────────────────────────────────────────────────────

export async function isGoogleConnected(username: string): Promise<boolean> {
  const tokens = await getStoredTokens(username);
  return !!tokens?.refresh_token;
}

// Brief per-instance cache — avoids repeated network calls within one warm instance.
// TTL: 90 seconds (shorter than the 5-min access-token expiry window we check below).
const _googleStatusCache = new Map<string, { status: IntegrationStatus; ts: number }>();
const GOOGLE_STATUS_TTL = 90_000;

/**
 * Returns a normalized IntegrationStatus for Google.
 *
 * Validates the OAuth tokens are still accepted by Google:
 * - If the stored access token is still fresh (not expired), we trust it and
 *   skip the network call (fast path, ~0ms).
 * - If the access token has expired we attempt a refresh.  A failed refresh
 *   means the refresh_token was revoked — we return "token_expired" so the
 *   settings page shows a truthful Re-authorize prompt instead of "Connected".
 *
 * Never throws — always resolves to a concrete state.
 */
export async function getGoogleConnectionStatus(username: string): Promise<IntegrationStatus> {
  const now = new Date().toISOString();

  // Serve from cache if recent
  const cached = _googleStatusCache.get(username);
  if (cached && Date.now() - cached.ts < GOOGLE_STATUS_TTL) return cached.status;

  const cache = (status: IntegrationStatus) => {
    _googleStatusCache.set(username, { status, ts: Date.now() });
    return status;
  };

  try {
    const tokens = await getStoredTokens(username);

    if (!tokens?.refresh_token) {
      return cache({ id: "google", state: "disconnected", lastCheckedAt: now });
    }

    // Fast path: access token is still fresh — no network call needed.
    const tokenStillFresh =
      tokens.expiry_date && tokens.access_token &&
      tokens.expiry_date > Date.now() + 5 * 60 * 1000; // 5-min buffer

    if (!tokenStillFresh) {
      // Access token is missing or expired — attempt a refresh to validate
      // the refresh_token is still accepted.
      const client = getOAuth2Client();
      client.setCredentials(tokens);
      try {
        const { token } = await client.getAccessToken();
        if (!token) {
          return cache({ id: "google", state: "token_expired", lastCheckedAt: now,
            error: "Could not refresh access token — please re-authorize." });
        }
        // Persist the refreshed credentials so subsequent calls are fast
        const updated = client.credentials as GoogleTokens;
        await writeUserStore(username, TOKENS_FILE, { ...tokens, ...updated });
      } catch {
        return cache({ id: "google", state: "token_expired", lastCheckedAt: now,
          error: "Token refresh failed — please re-authorize." });
      }
    }

    const granted = new Set(tokens.scope?.split(/\s+/).filter(Boolean) ?? []);
    const hasCalendar = granted.has(GOOGLE_SCOPE.calendar);
    const hasGmail    = granted.has(GOOGLE_SCOPE.gmail);
    const hasDrive    = granted.has(GOOGLE_SCOPE.drive);
    const allGranted  = hasCalendar && hasGmail && hasDrive;

    return cache({
      id:            "google",
      state:         allGranted ? "connected" : "permission_missing",
      lastCheckedAt: now,
      scopes:        [...granted],
      google: {
        calendar: hasCalendar,
        gmail:    hasGmail,
        drive:    hasDrive,
      },
    });
  } catch (err) {
    return cache({
      id:            "google",
      state:         "error",
      lastCheckedAt: now,
      error:         err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Authenticated googleapis client ──────────────────────────────────────────

/**
 * Returns a configured OAuth2Client ready to use with googleapis, or null if
 * Google is not connected for this user.  Callers must `await` this.
 */
export async function getAuthedClient(username: string) {
  const tokens = await getStoredTokens(username);
  if (!tokens?.refresh_token) return null;

  const client = getOAuth2Client();
  client.setCredentials(tokens);
  return client;
}
