import { google } from "googleapis";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const TOKEN_PATH = join(process.cwd(), ".data", "google-tokens.json");

const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/drive.readonly",
];

export const GOOGLE_SCOPE = {
  calendar: "https://www.googleapis.com/auth/calendar",
  gmail: "https://www.googleapis.com/auth/gmail.modify",
  drive: "https://www.googleapis.com/auth/drive.readonly",
} as const;

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
    scope: SCOPES,
    prompt: "consent",
  });
}

export async function exchangeCode(code: string) {
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(code);

  // Persist tokens to disk
  const dir = join(process.cwd(), ".data");
  if (!existsSync(dir)) {
    const { mkdirSync } = await import("fs");
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));

  return tokens;
}

export function getStoredTokens(): { access_token?: string; refresh_token?: string; expiry_date?: number; scope?: string } | null {
  try {
    if (!existsSync(TOKEN_PATH)) return null;
    const raw = readFileSync(TOKEN_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Returns the list of OAuth scopes granted by the user, derived from the
 *  stored token's `scope` string. Empty array if no token on disk. */
export function getGrantedScopes(): string[] {
  const tokens = getStoredTokens();
  if (!tokens?.scope || typeof tokens.scope !== "string") return [];
  return tokens.scope.split(/\s+/).filter(Boolean);
}

/** Per-scope connection status — so Settings can show Calendar/Gmail/Drive
 *  separately even though they share a single OAuth token. */
export function getGoogleConnectionStatus(): { calendar: boolean; gmail: boolean; drive: boolean; any: boolean } {
  const granted = new Set(getGrantedScopes());
  const hasToken = isGoogleConnected();
  return {
    calendar: hasToken && granted.has(GOOGLE_SCOPE.calendar),
    gmail: hasToken && granted.has(GOOGLE_SCOPE.gmail),
    drive: hasToken && granted.has(GOOGLE_SCOPE.drive),
    any: hasToken,
  };
}

export function getAuthedClient() {
  const tokens = getStoredTokens();
  if (!tokens?.refresh_token) return null;

  const client = getOAuth2Client();
  client.setCredentials(tokens);
  return client;
}

export function isGoogleConnected(): boolean {
  return !!getStoredTokens()?.refresh_token;
}
