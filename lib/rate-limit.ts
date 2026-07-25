/**
 * Rate limiter with two backends:
 *
 *   • checkRateLimitDurable() — Upstash Redis sliding window (when
 *     UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set). Enforced
 *     ACROSS all Vercel instances, so a user/IP can't multiply their quota by
 *     hitting different concurrent instances. This is the real abuse control.
 *
 *   • checkRateLimit() — module-level in-memory Map (per-instance). Fine for
 *     unauthenticated brute-force slowing where approximate is acceptable, and
 *     used as the automatic fallback when Redis is not configured or errors.
 *
 * Prefer the USERNAME as the key on authenticated routes (not the spoofable
 * x-forwarded-for IP), so the limit follows the account, not the connection.
 *
 * Default: 10 attempts per 60-second sliding window per key.
 */

import { Ratelimit, type Duration } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { resolveRedisRestConfig } from "@/lib/storage/redis-config";

interface Entry {
  count: number;
  resetAt: number; // epoch ms
}

const store = new Map<string, Entry>();

const WINDOW_MS      = 60_000; // 1 minute
const DEFAULT_MAX    = 10;

// ── Durable (Upstash) backend ──────────────────────────────────────────────────

let rlRedis: Redis | null | undefined;
function getRlRedis(): Redis | null {
  if (rlRedis !== undefined) return rlRedis;
  // Same dual-naming problem as lib/storage/lock.ts — the Marketplace
  // provisions KV_REST_API_*, not the UPSTASH_REDIS_REST_* that fromEnv() reads.
  const cfg = resolveRedisRestConfig();
  if (cfg) {
    try {
      rlRedis = new Redis(cfg);
    } catch (err) {
      console.error("[rate-limit] Upstash client init failed — limits are PER-INSTANCE:", err);
      rlRedis = null;
    }
  } else {
    // This one is a security control, so its degradation must be visible: the
    // effective login ceiling becomes limit × warm instances, and resets to
    // zero on every cold start.
    console.warn(
      "[rate-limit] No Upstash REST credentials — auth rate limits are PER-INSTANCE " +
      "and reset on cold start. Brute-force protection is substantially weaker."
    );
    rlRedis = null;
  }
  return rlRedis;
}

// Cache one Ratelimit instance per (max, window) so we don't rebuild on every call.
const limiterCache = new Map<string, Ratelimit>();
function getLimiter(maxAttempts: number, window: Duration): Ratelimit | null {
  const redis = getRlRedis();
  if (!redis) return null;
  const cacheKey = `${maxAttempts}:${window}`;
  let limiter = limiterCache.get(cacheKey);
  if (!limiter) {
    limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(maxAttempts, window),
      prefix: "rl",
      analytics: false,
    });
    limiterCache.set(cacheKey, limiter);
  }
  return limiter;
}

/**
 * Cross-instance durable rate-limit check (Upstash). Falls back to the
 * in-memory limiter when Redis is unconfigured or errors, so it is always safe
 * to call. `window` is an Upstash Duration string, e.g. "60 s" | "1 m" | "1 h".
 */
export async function checkRateLimitDurable(
  key: string,
  maxAttempts = DEFAULT_MAX,
  window: Duration = "60 s"
): Promise<{ allowed: true } | { allowed: false; retryAfter: number }> {
  const limiter = getLimiter(maxAttempts, window);
  if (!limiter) return checkRateLimit(key, maxAttempts);
  try {
    const { success, reset } = await limiter.limit(key);
    if (success) return { allowed: true };
    const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
    return { allowed: false, retryAfter };
  } catch (err) {
    console.warn("[rate-limit] durable limiter error — falling back to in-memory:", err instanceof Error ? err.message : err);
    return checkRateLimit(key, maxAttempts);
  }
}

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

/**
 * Extract the client IP for rate-limit keying.
 *
 * Prefer `x-real-ip`: on Vercel the platform sets it to the true client IP and
 * it is NOT client-spoofable. The LEFT-most `X-Forwarded-For` entry IS
 * client-controllable (a caller can prepend an arbitrary value), so trusting it
 * lets an attacker rotate the header per request and defeat the brute-force /
 * enumeration limiter entirely. If we must fall back to XFF, use the LAST entry
 * (appended by the trusted proxy), never the first.
 */
export function getClientIp(req: Request): string {
  const headers = req instanceof Request ? req.headers : new Headers();
  return (
    headers.get("x-real-ip")?.trim() ||
    headers.get("x-forwarded-for")?.split(",").pop()?.trim() ||
    "unknown"
  );
}
