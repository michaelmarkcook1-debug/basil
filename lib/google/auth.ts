import { google } from "googleapis";
import { readStore, writeStore } from "@/lib/storage/persistent";
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
 * Exchange an OAuth authorization code for tokens and persist them via the
 * shared store so they survive Vercel cold starts (included in BASIL_DATA
 * snapshot automatically by writeStore → persistSnapshot).
 */
export async function exchangeCode(code: string): Promise<GoogleTokens> {
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(code);
  await writeStore<GoogleTokens>(TOKENS_FILE, tokens as GoogleTokens);
  return tokens as GoogleTokens;
}

/**
 * Read stored Google OAuth tokens.
 *
 * Priority:
 * 1. Shared persistent store (`DATA_DIR/google-tokens.json`), which is
 *    restored from BASIL_DATA env var on Vercel cold starts.
 * 2. Manual `GOOGLE_TOKENS` env var fallback (for pre-BASIL_DATA deployments
 *    or emergency manual override — set once via `vercel env add`).
 */
export async function getStoredTokens(): Promise<GoogleTokens | null> {
  // readStore calls maybeRestore() internally, so cold-start tokens are
  // hydrated from BASIL_DATA before the file read happens.
  const fromStore = await readStore<GoogleTokens | null>(TOKENS_FILE, null);
  if (fromStore?.refresh_token) return fromStore;

  // Manual env var fallback — never written by the app, only read.
  if (process.env.GOOGLE_TOKENS) {
    try {
      const parsed = JSON.parse(process.env.GOOGLE_TOKENS) as GoogleTokens;
      if (parsed?.refresh_token) return parsed;
    } catch {
      /* ignore malformed value */
    }
  }

  return null;
}

// ── Scope helpers ─────────────────────────────────────────────────────────────

/** Returns the list of OAuth scopes granted by the user. Empty if no token. */
export async function getGrantedScopes(): Promise<string[]> {
  const tokens = await getStoredTokens();
  if (!tokens?.scope || typeof tokens.scope !== "string") return [];
  return tokens.scope.split(/\s+/).filter(Boolean);
}

// ── Connection status ─────────────────────────────────────────────────────────

export async function isGoogleConnected(): Promise<boolean> {
  const tokens = await getStoredTokens();
  return !!tokens?.refresh_token;
}

/**
 * Returns a normalized IntegrationStatus for Google.
 * Never throws — always resolves to a concrete state.
 */
export async function getGoogleConnectionStatus(): Promise<IntegrationStatus> {
  const now = new Date().toISOString();
  try {
    const tokens = await getStoredTokens();

    if (!tokens?.refresh_token) {
      return {
        id:             "google",
        state:          "disconnected",
        lastCheckedAt:  now,
      };
    }

    const granted = new Set(tokens.scope?.split(/\s+/).filter(Boolean) ?? []);
    const hasCalendar = granted.has(GOOGLE_SCOPE.calendar);
    const hasGmail    = granted.has(GOOGLE_SCOPE.gmail);
    const hasDrive    = granted.has(GOOGLE_SCOPE.drive);
    const allGranted  = hasCalendar && hasGmail && hasDrive;

    return {
      id:            "google",
      state:         allGranted ? "connected" : "permission_missing",
      lastCheckedAt: now,
      scopes:        [...granted],
      google: {
        calendar: hasCalendar,
        gmail:    hasGmail,
        drive:    hasDrive,
      },
    };
  } catch (err) {
    return {
      id:            "google",
      state:         "error",
      lastCheckedAt: now,
      error:         err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Authenticated googleapis client ──────────────────────────────────────────

/**
 * Returns a configured OAuth2Client ready to use with googleapis, or null if
 * Google is not connected.  Callers must `await` this.
 */
export async function getAuthedClient() {
  const tokens = await getStoredTokens();
  if (!tokens?.refresh_token) return null;

  const client = getOAuth2Client();
  client.setCredentials(tokens);
  return client;
}
