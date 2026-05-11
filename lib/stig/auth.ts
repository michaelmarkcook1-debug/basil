import "server-only";

import { timingSafeEqual } from "node:crypto";
import { getSessionUser } from "@/lib/auth";

export interface StigRequestUser {
  username: string;
  authMode: "session" | "token";
}

function bearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (match?.[1]) return match[1].trim();

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
 * Phone/Siri/external clients may use Authorization: Bearer <STIG_API_TOKEN>.
 * The token route maps to STIG_API_USERNAME, falling back to PRIMARY_OWNER_USERNAME
 * or ADMIN_USERNAME if explicitly configured.
 */
export async function getStigRequestUser(req: Request): Promise<StigRequestUser | null> {
  const sessionUser = await getSessionUser();
  if (sessionUser) return { username: sessionUser, authMode: "session" };

  const configuredToken = process.env.STIG_API_TOKEN?.trim();
  const suppliedToken = bearerToken(req);
  if (!configuredToken || !suppliedToken || !safeEqual(configuredToken, suppliedToken)) {
    return null;
  }

  const username =
    process.env.STIG_API_USERNAME?.trim() ||
    process.env.PRIMARY_OWNER_USERNAME?.trim() ||
    process.env.ADMIN_USERNAME?.trim();

  if (!username) return null;
  return { username, authMode: "token" };
}
