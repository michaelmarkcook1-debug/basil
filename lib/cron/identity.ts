/**
 * lib/cron/identity.ts — resolve the acting user for cron / server-to-server calls.
 *
 * Per-user cron fan-out wrappers (e.g. /api/cron/poll-ingest, /api/cron/reprocess,
 * /api/cron/generate-briefing) send one request PER USER with an explicit
 * X-Basil-Username header so each user's data is processed under their OWN
 * identity. The worker routes must honour that header — otherwise every
 * CRON_SECRET call collapses onto the first admin user, and non-admin customers
 * silently get nothing (the exact "paying users never get a morning brief" bug).
 *
 * server-only.
 */

import "server-only";
import { getUsers, isAdminUser } from "@/lib/users";

/** True when the request carries a valid CRON_SECRET bearer token. */
export function isCronRequest(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

/**
 * Resolve the target username for a CRON_SECRET-authenticated request.
 *
 * Prefers the explicit X-Basil-Username header the fan-out wrappers send. A
 * direct cron invocation WITHOUT the header falls back to the first admin /
 * first user so the call still does something — but this fallback is a safety
 * net for misconfiguration, never the multi-user path. Returns null only when
 * no users exist at all.
 */
export async function resolveCronUser(req: Request): Promise<string | null> {
  const header = req.headers.get("x-basil-username");
  if (header) return header;
  const users = await getUsers();
  const adminUser = users.find((u) => isAdminUser(u.username)) ?? users[0];
  return adminUser?.username ?? null;
}
