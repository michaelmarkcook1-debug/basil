/**
 * lib/storage/counter.ts — durable, (optionally) atomic numeric counters.
 *
 * Backs the AI spend guard and durable rate limiter. Two backends:
 *
 *   1. Upstash Redis (when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 *      are set) — INCRBYFLOAT is ATOMIC across all serverless instances, so
 *      concurrent increments cannot be lost. This is the HARD-cap path.
 *
 *   2. Vercel Blob fallback (no Redis configured) — read-modify-write through
 *      the persistent store. This is NON-ATOMIC: two instances incrementing
 *      concurrently can lose an update (last-write-wins), so any cap enforced
 *      on this backend is APPROXIMATE / SOFT. The append-only spend event log
 *      (lib/ai/spend-log.ts) remains the recoverable source of truth, and a
 *      reconciliation cron can recompute exact totals from it.
 *
 * `isDurableCounter()` lets callers decide fail-open vs fail-closed behaviour
 * based on whether an atomic store is actually available.
 *
 * IMPORTANT: server-only. Never import from a client component.
 */

import "server-only";
import { Redis } from "@upstash/redis";
import { resolveRedisRestConfig } from "@/lib/storage/redis-config";
import { readStore, writeStore } from "@/lib/storage/persistent";

// ── Redis singleton (lazy) ────────────────────────────────────────────────────

let redisClient: Redis | null | undefined;

function getRedis(): Redis | null {
  if (redisClient !== undefined) return redisClient;
  // Resolve BOTH naming conventions. This was gated on the UPSTASH_* pair and
  // used Redis.fromEnv(), which only recognises those names — but the Vercel
  // Marketplace integration provisions KV_REST_API_*. So Upstash was live and
  // working (lock.ts, already migrated, uses it) while the spend counter
  // silently sat on the last-write-wins Blob fallback, reporting
  // `durable: false` and making every spend cap SOFT: concurrent calls can lose
  // an update, so a ceiling can be overshot. Exactly the same silent-no-op this
  // resolver was written to kill, in the one place that most needs to be exact.
  const cfg = resolveRedisRestConfig();
  if (cfg) {
    try {
      redisClient = new Redis(cfg);
    } catch (err) {
      console.error("[counter] Redis init failed — falling back to Blob:", err instanceof Error ? err.message : err);
      redisClient = null;
    }
  } else {
    redisClient = null;
  }
  return redisClient;
}

/** True when an ATOMIC cross-instance counter (Upstash Redis) is configured. */
export function isDurableCounter(): boolean {
  return getRedis() !== null;
}

// ── Blob key sanitisation ──────────────────────────────────────────────────────

/** Blob filenames can't contain ":" — map counter keys to safe filenames. */
function blobFile(key: string): string {
  return `${key.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
}

const BLOB_SCOPE = "counters";

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Increment a counter by `amount` (may be negative for rollback/reconcile).
 *
 * @returns the new value and whether the increment was atomic/durable.
 */
export async function incrCounter(
  key: string,
  amount: number,
  ttlSeconds?: number
): Promise<{ value: number; durable: boolean }> {
  const r = getRedis();
  if (r) {
    const value = await r.incrbyfloat(key, amount);
    if (ttlSeconds && ttlSeconds > 0) {
      // Best-effort TTL so stale period counters self-expire. Don't fail the
      // increment if EXPIRE errors.
      await r.expire(key, ttlSeconds).catch(() => undefined);
    }
    return { value: typeof value === "number" ? value : Number(value), durable: true };
  }

  // Blob fallback — NON-ATOMIC read-modify-write (documented soft-cap race).
  const current = await readStore<number>(blobFile(key), 0, BLOB_SCOPE);
  const next = (typeof current === "number" ? current : Number(current) || 0) + amount;
  await writeStore(blobFile(key), next, BLOB_SCOPE, { durability: "strong" });
  return { value: next, durable: false };
}

/** Read a counter's current value (0 if unset). */
export async function getCounter(key: string): Promise<number> {
  const r = getRedis();
  if (r) {
    const v = await r.get<number | string>(key);
    if (v === null || v === undefined) return 0;
    return typeof v === "number" ? v : Number(v) || 0;
  }
  const current = await readStore<number>(blobFile(key), 0, BLOB_SCOPE);
  return typeof current === "number" ? current : Number(current) || 0;
}

/** Delete/zero a counter. */
export async function resetCounter(key: string): Promise<void> {
  const r = getRedis();
  if (r) {
    await r.del(key);
    return;
  }
  await writeStore(blobFile(key), 0, BLOB_SCOPE, { durability: "strong" });
}
