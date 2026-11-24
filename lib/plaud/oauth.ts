/**
 * lib/plaud/oauth.ts — signing Basil in to the user's Plaud account.
 *
 * Plaud's official remote MCP server (mcp.plaud.ai/mcp, launched Sept 2026)
 * uses standard MCP authorization, read from its own discovery documents:
 *   /.well-known/oauth-protected-resource → authorization server https://mcp.plaud.ai/
 *   /.well-known/oauth-authorization-server → /authorize, /token, /register;
 *   authorization code + PKCE (S256), refresh tokens, dynamic client registration.
 *
 * Basil registers itself once per user (a public client, no secret), sends the
 * user to Plaud to approve, and keeps the tokens encrypted in the user's
 * secure store ("plaud"). Read-only: Basil only lists and reads recordings.
 */
import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { getIntegrationToken, saveIntegrationToken, deleteIntegrationToken } from "@/lib/storage/secure-token-store";
import { publicOrigin } from "@/lib/http/origin";

export const PLAUD_ISSUER = "https://mcp.plaud.ai";
export const PLAUD_RESOURCE = "https://mcp.plaud.ai/mcp";
const TIMEOUT_MS = 15_000;

export interface PlaudTokens {
  clientId: string;
  redirectUri: string;
  accessToken?: string;
  refreshToken?: string;
  /** ms since epoch. */
  expiresAt?: number;
  connectedAt?: string;
  account?: string;
}

export const redirectUri = () => `${publicOrigin()}/api/auth/plaud/callback`;

export async function getPlaudTokens(username: string): Promise<PlaudTokens | null> {
  return getIntegrationToken<PlaudTokens>(username, "plaud");
}

export async function savePlaudTokens(username: string, t: PlaudTokens): Promise<void> {
  await saveIntegrationToken(username, "plaud", t);
}

export async function deletePlaudTokens(username: string): Promise<void> {
  await deleteIntegrationToken(username, "plaud");
}

export async function isPlaudConnected(username: string): Promise<boolean> {
  return !!(await getPlaudTokens(username))?.refreshToken;
}

/** Register Basil as a public OAuth client with Plaud (RFC 7591), reusing it if the redirect is unchanged. */
async function ensureClient(username: string): Promise<{ clientId: string; redirectUri: string }> {
  const cur = await getPlaudTokens(username);
  const redirect = redirectUri();
  if (cur?.clientId && cur.redirectUri === redirect) return { clientId: cur.clientId, redirectUri: redirect };
  const res = await fetch(`${PLAUD_ISSUER}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "Basil",
      redirect_uris: [redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Plaud refused to register Basil (${res.status}).`);
  const body = (await res.json()) as { client_id?: string };
  if (!body.client_id) throw new Error("Plaud did not return a client id.");
  await savePlaudTokens(username, { ...(cur ?? {}), clientId: body.client_id, redirectUri: redirect, accessToken: undefined, refreshToken: undefined, expiresAt: undefined });
  return { clientId: body.client_id, redirectUri: redirect };
}

const b64url = (b: Buffer) => b.toString("base64url");

/** Where to send the user, plus the PKCE verifier to keep (in an httpOnly cookie) until the callback. */
export async function plaudAuthorizeUrl(username: string, state: string): Promise<{ url: string; verifier: string }> {
  const { clientId, redirectUri: redirect } = await ensureClient(username);
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    resource: PLAUD_RESOURCE,
  });
  return { url: `${PLAUD_ISSUER}/authorize?${q}`, verifier };
}

interface TokenResponse { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }

async function tokenCall(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${PLAUD_ISSUER}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ ...params, resource: PLAUD_RESOURCE }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse; // ci-ok: an unreadable body is reported via the status below
  if (!res.ok || !body.access_token) throw new Error(`Plaud sign-in failed (${res.status}${body.error ? `: ${body.error}` : ""}).`);
  return body;
}

export async function exchangePlaudCode(username: string, code: string, verifier: string): Promise<void> {
  const cur = await getPlaudTokens(username);
  if (!cur?.clientId) throw new Error("Plaud sign-in expired. Start again from Settings.");
  const t = await tokenCall({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: cur.clientId, redirect_uri: cur.redirectUri });
  await savePlaudTokens(username, {
    ...cur,
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? cur.refreshToken,
    expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000,
    connectedAt: new Date().toISOString(),
  });
}

export class PlaudAuthError extends Error {}

/** A valid access token, refreshing it when it is within a minute of expiry. */
export async function plaudAccessToken(username: string, opts: { force?: boolean } = {}): Promise<string> {
  const cur = await getPlaudTokens(username);
  if (!cur?.refreshToken) throw new PlaudAuthError("Plaud is not connected.");
  if (!opts.force && cur.accessToken && (cur.expiresAt ?? 0) > Date.now() + 60_000) return cur.accessToken;
  try {
    const t = await tokenCall({ grant_type: "refresh_token", refresh_token: cur.refreshToken, client_id: cur.clientId });
    await savePlaudTokens(username, {
      ...cur,
      accessToken: t.access_token,
      // Refresh tokens may rotate; keep the new one when given.
      refreshToken: t.refresh_token ?? cur.refreshToken,
      expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000,
    });
    return t.access_token!;
  } catch (e) {
    throw new PlaudAuthError(`Plaud needs reconnecting: ${e instanceof Error ? e.message : String(e)}`);
  }
}
