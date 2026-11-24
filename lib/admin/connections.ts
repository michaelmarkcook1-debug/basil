/**
 * lib/admin/connections.ts — every account's data sources in one place, for
 * the admin "Connections" card.
 *
 * Live checks where they are safe and cheap:
 *   - Google: refreshes the access token when stale (getGoogleConnectionStatus),
 *     so a revoked sign-in shows as expired, not "connected".
 *   - Slack: auth.test on each stored token.
 *   - Linear: a one-field `viewer` query with the stored key.
 *   - Microsoft: its own status check.
 *   - Zoom: token present only. Zoom rotates the refresh token on every
 *     refresh, so a "check" would be a write; Basil's own use reports failures.
 *
 * `renewAll` re-runs the setup that does not need the person: Gmail push and
 * Calendar watch registration for every account whose Google is connected.
 * A broken sign-in can only be fixed by that person, signed in as themselves.
 */
import "server-only";
import { WebClient, LogLevel } from "@slack/web-api";
import { getUsers } from "@/lib/users";
import { getGoogleConnectionStatus } from "@/lib/google/auth";
import { getMicrosoftConnectionStatus } from "@/lib/microsoft/auth";
import { getSlackConfig } from "@/lib/slack/client";
import { getLinearConfig } from "@/lib/linear/client";
import { isZoomConnected } from "@/lib/zoom/auth";
import { autoRegisterGoogleWebhooks } from "@/lib/google/register-webhooks";

export type SourceId = "google" | "slack" | "zoom" | "linear" | "microsoft";
export type SourceState = "ok" | "broken" | "off" | "unchecked";

export interface SourceCheck {
  state: SourceState;
  detail?: string;
}

export interface AccountConnections {
  username: string;
  name: string;
  email: string;
  disabled: boolean;
  sources: Record<SourceId, SourceCheck>;
}

/** Where each source is (re)connected. The person must open it signed in as themselves. */
export const RECONNECT_PATH: Record<SourceId, string> = {
  google: "/api/auth/google?from=settings",
  slack: "/api/auth/slack/oauth?from=settings",
  zoom: "/api/auth/zoom?from=%2Fdashboard%2Fsettings%3Fconnected%3Dzoom",
  linear: "/dashboard/settings",
  microsoft: "/api/auth/microsoft?from=settings",
};

const TIMEOUT_MS = 8_000;

function withTimeout<T>(p: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), TIMEOUT_MS))]);
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 160);

async function checkGoogle(username: string): Promise<SourceCheck> {
  try {
    const s = await getGoogleConnectionStatus(username);
    if (s.state === "connected") return { state: "ok" };
    if (s.state === "disconnected") return { state: "off" };
    return { state: "broken", detail: s.error ?? s.state };
  } catch (e) {
    return { state: "broken", detail: msg(e) };
  }
}

async function checkSlack(username: string): Promise<SourceCheck> {
  try {
    const cfg = await getSlackConfig(username);
    const tokens = [cfg.userToken, cfg.botToken].filter((t): t is string => !!t);
    if (tokens.length === 0) return { state: "off" };
    for (const token of tokens) {
      const web = new WebClient(token, { retryConfig: { retries: 0 }, logLevel: LogLevel.ERROR });
      try {
        await web.auth.test();
      } catch (e) {
        return { state: "broken", detail: msg(e) };
      }
    }
    return { state: "ok", detail: cfg.teamName };
  } catch (e) {
    return { state: "broken", detail: msg(e) };
  }
}

async function checkLinear(username: string): Promise<SourceCheck> {
  try {
    const { apiKey } = await getLinearConfig(username);
    if (!apiKey) return { state: "off" };
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: apiKey },
      body: JSON.stringify({ query: "{ viewer { id } }" }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { state: "broken", detail: `Linear ${res.status}` };
    const body = (await res.json()) as { data?: { viewer?: { id?: string } }; errors?: { message?: string }[] };
    return body.data?.viewer?.id ? { state: "ok" } : { state: "broken", detail: body.errors?.[0]?.message ?? "No viewer" };
  } catch (e) {
    return { state: "broken", detail: msg(e) };
  }
}

async function checkMicrosoft(username: string): Promise<SourceCheck> {
  try {
    const s = await getMicrosoftConnectionStatus(username);
    if (s.state === "connected") return { state: "ok" };
    if (s.state === "disconnected") return { state: "off" };
    return { state: "broken", detail: s.error ?? s.state };
  } catch (e) {
    return { state: "broken", detail: msg(e) };
  }
}

async function checkZoom(username: string): Promise<SourceCheck> {
  try {
    return (await isZoomConnected(username)) ? { state: "ok", detail: "Sign-in saved (not test-called)" } : { state: "off" };
  } catch (e) {
    return { state: "broken", detail: msg(e) };
  }
}

const timedOut: SourceCheck = { state: "unchecked", detail: "Check timed out" };

export async function checkAllConnections(): Promise<AccountConnections[]> {
  const users = await getUsers();
  return Promise.all(
    users.map(async (u) => {
      const [google, slack, zoom, linear, microsoft] = await Promise.all([
        withTimeout(checkGoogle(u.username), timedOut),
        withTimeout(checkSlack(u.username), timedOut),
        withTimeout(checkZoom(u.username), timedOut),
        withTimeout(checkLinear(u.username), timedOut),
        withTimeout(checkMicrosoft(u.username), timedOut),
      ]);
      return {
        username: u.username,
        name: [u.name, u.surname].filter(Boolean).join(" ") || u.username,
        email: u.email,
        disabled: !!u.disabled,
        sources: { google, slack, zoom, linear, microsoft },
      };
    }),
  );
}

export interface RenewResult {
  username: string;
  gmail: "ok" | "skipped" | "error";
  calendar: "ok" | "skipped" | "error";
}

/** Re-register Gmail push and Calendar watch for every enabled account whose Google sign-in works. */
export async function renewAll(): Promise<RenewResult[]> {
  const users = (await getUsers()).filter((u) => !u.disabled);
  const out: RenewResult[] = [];
  for (const u of users) {
    const g = await withTimeout(checkGoogle(u.username), timedOut);
    if (g.state !== "ok") {
      out.push({ username: u.username, gmail: "skipped", calendar: "skipped" });
      continue;
    }
    const r = await autoRegisterGoogleWebhooks(u.username);
    out.push({ username: u.username, ...r });
  }
  return out;
}
