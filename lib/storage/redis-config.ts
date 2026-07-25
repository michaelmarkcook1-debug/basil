import "server-only";

/**
 * Resolve Upstash REST credentials from EITHER naming convention.
 *
 * This exists because the two conventions are both real and both live:
 *
 *   • `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` — what the Upstash
 *     SDK's `Redis.fromEnv()` looks for, and what you get setting the vars by
 *     hand from the Upstash console.
 *   • `KV_REST_API_URL` / `KV_REST_API_TOKEN` — what the Vercel Marketplace
 *     integration actually provisions (inherited from the old Vercel KV naming).
 *
 * Provisioning Upstash through the Marketplace therefore gives you working
 * credentials under names the SDK does not recognise. Both `withLock` and the
 * durable rate limiter were gated on the UPSTASH_* pair, so the integration
 * would have installed cleanly, reported success, and changed NOTHING —
 * locks would have kept silently degrading to a per-instance mutex.
 *
 * Returns null when neither pair is fully present, which callers treat as
 * "no distributed backend available" and degrade explicitly.
 */
export function resolveRedisRestConfig(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}
