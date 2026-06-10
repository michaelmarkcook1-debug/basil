/**
 * lib/auth/oauth-state.ts — CSRF protection for OAuth connect flows.
 *
 * Without a state check, an attacker can run their OWN provider authorization,
 * capture the resulting callback URL, and trick a logged-in victim into opening
 * it — silently linking the attacker's account/tokens to the victim's Basil
 * session (login CSRF / account linking). The defence is standard: on
 * initiation we mint a random `state`, store it in an httpOnly cookie AND put it
 * in the consent URL; on callback we require the echoed `state` to equal the
 * cookie. The attacker's browser never holds the victim's cookie, so the check
 * fails.
 *
 * Framework-light on purpose: initiation routes set the returned cookie on their
 * own NextResponse (matching the existing pattern), and callbacks read it off
 * the raw request — no reliance on the next/headers cookie mutation timing.
 *
 * server-only.
 */

import "server-only";
import { randomBytes, timingSafeEqual } from "node:crypto";

const PREFIX = "basil_oauth_state_";

export interface OAuthStateCookie {
  name: string;
  value: string;
  state: string;
  options: {
    httpOnly: true;
    secure: boolean;
    sameSite: "lax";
    path: "/";
    maxAge: number;
  };
}

/** Mint a fresh state + the cookie the initiation route should set on its response. */
export function buildOAuthState(provider: string): OAuthStateCookie {
  const state = randomBytes(24).toString("base64url");
  return {
    name: `${PREFIX}${provider}`,
    value: state,
    state,
    options: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 600, // 10 minutes — an OAuth round-trip is far shorter
    },
  };
}

/** Read a single cookie value off a raw Request's Cookie header. */
function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/**
 * Verify the `state` echoed back on the callback equals the cookie set at
 * initiation. Constant-time compare. Returns false if either is missing.
 */
export function verifyOAuthState(provider: string, req: Request, received: string | null): boolean {
  const stored = readCookie(req, `${PREFIX}${provider}`);
  if (!received || !stored) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(stored);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Cookie descriptor that clears the state cookie (set on the callback response). */
export function clearOAuthStateCookie(provider: string): { name: string; value: string; options: { path: "/"; maxAge: 0 } } {
  return { name: `${PREFIX}${provider}`, value: "", options: { path: "/", maxAge: 0 } };
}
