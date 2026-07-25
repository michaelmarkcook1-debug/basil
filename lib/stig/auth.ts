import "server-only";

import { timingSafeEqual } from "node:crypto";
import { getSessionUser } from "@/lib/auth";
import { verifySiriToken } from "@/lib/auth/siri-tokens";

export interface StigRequestUser {
  username: string;
  authMode: "session" | "token";
}

function bearerToken(req: Request): string | null {
  const auth = (req.headers.get("authorization") || "").trim();
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (match?.[1]) return match[1].trim();
  // Raw token pasted without the "Bearer " prefix — the #1 hand-built-Shortcut
  // mistake. Unambiguous thanks to the bsl_ prefix, so accept it.
  if (auth.startsWith("bsl_")) return auth;

  const headerToken = req.headers.get("x-stig-api-key");
  return headerToken?.trim() || null;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Resolve the user for a Stig API request.
 *
 * Browser/dashboard calls use the normal Basil session cookie.
 * Phone/Siri/external clients use Authorization: Bearer <token>, resolved in
 * order:
 *   1. Per-user Siri token (generated in Settings → Developer → Siri Shortcut;
 *      "bsl_…" prefix, hashed at rest, revocable, works for every user).
 *   2. Legacy single-user env token: STIG_API_TOKEN → STIG_API_USERNAME
 *      (falling back to PRIMARY_OWNER_USERNAME / ADMIN_USERNAME).
 */
export async function getStigRequestUser(
  req: Request,
  opts?: { bodyToken?: string | null }
): Promise<StigRequestUser | null> {
  const sessionUser = await getSessionUser();
  if (sessionUser) return { username: sessionUser, authMode: "session" };

  // Header token first, then a token passed in the request body — Shortcuts
  // users get body-token as the recommended path because header configuration
  // is where hand-built Shortcuts most often go wrong.
  const suppliedToken = bearerToken(req) ?? opts?.bodyToken?.trim() ?? null;
  if (!suppliedToken) return null;

  // Per-user Siri/Shortcuts token — the self-serve path. verifySiriToken is a
  // cheap no-op (prefix check) for non-"bsl_" tokens, so legacy callers skip it.
  const siriUser = await verifySiriToken(suppliedToken);
  if (siriUser) return { username: siriUser, authMode: "token" };

  const configuredToken = process.env.STIG_API_TOKEN?.trim();
  if (!configuredToken || !safeEqual(configuredToken, suppliedToken)) {
    return null;
  }

  const username =
    process.env.STIG_API_USERNAME?.trim() ||
    process.env.PRIMARY_OWNER_USERNAME?.trim() || // ci-ok: token-verified STIG principal resolution (env config), returns null if unset — not an ingestion data-owner default
    process.env.ADMIN_USERNAME?.trim();

  if (!username) return null;
  return { username, authMode: "token" };
}
