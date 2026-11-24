/**
 * lib/readai/oauth.ts — signing Basil in to the user's Read AI account.
 *
 * Read AI's public API (open beta, all plans) uses OAuth via its own identity
 * server, read live from https://authn.read.ai/.well-known/openid-configuration
 * (2026-11-24):
 *   registration  https://api.read.ai/oauth/register   (dynamic client registration)
 *   authorize     https://authn.read.ai/oauth2/auth
 *   token         https://authn.read.ai/oauth2/token
 *   scopes        openid email profile offline_access meeting:read
 *   auth methods  include "none" (public client + PKCE)
 * Access tokens last ~10 minutes; refresh tokens ~6 months and rotate on use
 * (the previous one keeps working briefly), per Read AI's docs.
 *
 * Read-only: Basil asks only for meeting:read.
 */
import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { getIntegrationToken, saveIntegrationToken, deleteIntegrationToken } from "@/lib/storage/secure-token-store";
import { publicOrigin } from "@/lib/http/origin";

const REGISTER = "https://api.read.ai/oauth/register";
const AUTHORIZE = "https://authn.read.ai/oauth2/auth";
const TOKEN = "https://authn.read.ai/oauth2/token";
const SCOPES = "openid email profile offline_access meeting:read";
const TIMEOUT_MS = 15_000;

export interface ReadAiTokens {
  clientId: string;
  redirectUri: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  connectedAt?: string;
}

export const readAiRedirectUri = () => `${publicOrigin()}/api/auth/readai/callback`;

export async function getReadAiTokens(username: string): Promise<ReadAiTokens | null> {
  return getIntegrationToken<ReadAiTokens>(username, "readai");
}
export async function saveReadAiTokens(username: string, t: ReadAiTokens): Promise<void> {
  await saveIntegrationToken(username, "readai", t);
}
export async function deleteReadAiTokens(username: string): Promise<void> {
  await deleteIntegrationToken(username, "readai");
}
export async function isReadAiConnected(username: string): Promise<boolean> {
  return !!(await getReadAiTokens(username))?.refreshToken;
}

async function ensureClient(username: string): Promise<{ clientId: string; redirectUri: string }> {
  const cur = await getReadAiTokens(username);
  const redirect = readAiRedirectUri();
  if (cur?.clientId && cur.redirectUri === redirect) return { clientId: cur.clientId, redirectUri: redirect };
  const res = await fetch(REGISTER, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "Basil",
      redirect_uris: [redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPES,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Read AI refused to register Basil (${res.status}).`);
  const body = (await res.json()) as { client_id?: string };
  if (!body.client_id) throw new Error("Read AI did not return a client id.");
  await saveReadAiTokens(username, { clientId: body.client_id, redirectUri: redirect });
  return { clientId: body.client_id, redirectUri: redirect };
}

export async function readAiAuthorizeUrl(username: string, state: string): Promise<{ url: string; verifier: string }> {
  const { clientId, redirectUri } = await ensureClient(username);
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: SCOPES,
    code_challenge: challenge, code_challenge_method: "S256", state,
  });
  return { url: `${AUTHORIZE}?${q}`, verifier };
}

interface TokenResponse { access_token?: string; refresh_token?: string; expires_in?: number; error?: string }

async function tokenCall(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse; // ci-ok: unreadable body → reported via the status
  if (!res.ok || !body.access_token) throw new Error(`Read AI sign-in failed (${res.status}${body.error ? `: ${body.error}` : ""}).`);
  return body;
}

export async function exchangeReadAiCode(username: string, code: string, verifier: string): Promise<void> {
  const cur = await getReadAiTokens(username);
  if (!cur?.clientId) throw new Error("Read AI sign-in expired. Start again from Settings.");
  const t = await tokenCall({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: cur.clientId, redirect_uri: cur.redirectUri });
  await saveReadAiTokens(username, {
    ...cur, accessToken: t.access_token, refreshToken: t.refresh_token ?? cur.refreshToken,
    expiresAt: Date.now() + (t.expires_in ?? 600) * 1000, connectedAt: new Date().toISOString(),
  });
}

export class ReadAiAuthError extends Error {}

/** A valid access token (they last ~10 minutes), refreshing and storing the rotated refresh token. */
export async function readAiAccessToken(username: string, opts: { force?: boolean } = {}): Promise<string> {
  const cur = await getReadAiTokens(username);
  if (!cur?.refreshToken) throw new ReadAiAuthError("Read AI is not connected.");
  if (!opts.force && cur.accessToken && (cur.expiresAt ?? 0) > Date.now() + 60_000) return cur.accessToken;
  try {
    const t = await tokenCall({ grant_type: "refresh_token", refresh_token: cur.refreshToken, client_id: cur.clientId });
    await saveReadAiTokens(username, {
      ...cur, accessToken: t.access_token, refreshToken: t.refresh_token ?? cur.refreshToken,
      expiresAt: Date.now() + (t.expires_in ?? 600) * 1000,
    });
    return t.access_token!;
  } catch (e) {
    throw new ReadAiAuthError(`Read AI needs reconnecting: ${e instanceof Error ? e.message : String(e)}`);
  }
}
