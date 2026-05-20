/**
 * Simple in-memory IP-based rate limiter.
 *
 * Designed for auth and AI endpoints where a small burst of legitimate
 * requests is acceptable but brute-force or runaway loops should be blocked.
 *
 * Default: 10 attempts per 60-second sliding window per key.
 * Pass a custom `maxAttempts` to override for a specific route.
 *
 * Memory: entries auto-expire; module-level map is fine for a single-instance
 * deployment (Vercel Fluid Compute reuses instances across concurrent requests).
 */

interface Entry {
  count: number;
  resetAt: number; // epoch ms
}

const store = new Map<string, Entry>();

const WINDOW_MS      = 60_000; // 1 minute
const DEFAULT_MAX    = 10;

/** Prune expired entries (runs inline on every check — cheap for low traffic). */
function prune() {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.resetAt < now) store.delete(key);
  }
}

/**
 * Check whether the given key (typically an IP address) is within rate limits.
 *
 * @param key        - Unique identifier for the rate-limit bucket (e.g. `chat:${ip}`)
 * @param maxAttempts - Max calls allowed per window (default 10)
 * @returns `{ allowed: true }` or `{ allowed: false, retryAfter: <seconds> }`
 */
export function checkRateLimit(
  key: string,
  maxAttempts = DEFAULT_MAX,
): { allowed: true } | { allowed: false; retryAfter: number } {
  prune();
  const now = Date.now();

  let entry = store.get(key);
  if (!entry || entry.resetAt < now) {
    entry = { count: 1, resetAt: now + WINDOW_MS };
    store.set(key, entry);
    return { allowed: true };
  }

  entry.count += 1;
  if (entry.count > maxAttempts) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    return { allowed: false, retryAfter };
  }

  return { allowed: true };
}

/** Extract the real client IP from common proxy headers or fall back to a constant. */
export function getClientIp(req: Request): string {
  const headers = req instanceof Request ? req.headers : new Headers();
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip") ||
    "unknown"
  );
}
