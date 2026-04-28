/**
 * Timezone resolution utilities.
 *
 * When a user has opted in to IP-based timezone detection (useIpTimezone = true),
 * Basil reads the `x-vercel-ip-timezone` header that Vercel injects automatically
 * on every request from its Edge Network — no third-party lookup needed.
 *
 * Falls back to the stored settings timezone if the header is absent or invalid.
 */

import { isValidIANATimezone } from "@/lib/settings/store";

/**
 * Extract the Vercel-injected IP timezone from request headers.
 * Returns null if not present or not a valid IANA identifier.
 */
export function getIpTimezone(req: Request): string | null {
  const tz = req.headers.get("x-vercel-ip-timezone");
  if (tz && isValidIANATimezone(tz)) return tz;
  return null;
}

/**
 * Resolve the effective timezone for a request.
 *
 * - If `useIpTimezone` is true and the Vercel header provides a valid timezone, use it.
 * - Otherwise fall back to the user's stored `settings.timezone`.
 * - As a final fallback, use "UTC".
 */
export function resolveTimezone(
  settings: { timezone: string; useIpTimezone?: boolean },
  req?: Request,
): string {
  if (settings.useIpTimezone && req) {
    const ipTz = getIpTimezone(req);
    if (ipTz) return ipTz;
  }
  return settings.timezone || "UTC";
}
