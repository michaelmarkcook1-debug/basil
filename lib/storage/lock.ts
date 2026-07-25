/**
 * lib/storage/lock.ts — short-lived mutual exclusion for read-modify-write.
 *
 * The flat-file store is last-write-wins: two requests that both read a JSON
 * collection, mutate it, and write it back will clobber each other (the classic
 * "concurrent signups erase one account" / "done action resurrects" bug). A
 * lock around the read-modify-write serializes them.
 *
 * Two backends:
 *   • Upstash Redis (when configured) — a real cross-instance lock via SET NX PX.
 *     This is what makes it correct under Vercel's multi-instance autoscaling.
 *   • In-process promise chain (no Redis) — serializes within a single instance.
 *     Correct for local dev / single-instance; degrades to best-effort otherwise,
 *     which is still strictly better than no lock.
 *
 * server-only.
 */

import "server-only";
import { Redis } from "@upstash/redis";
import { resolveRedisRestConfig } from "@/lib/storage/redis-config";

// ── Redis singleton (lazy) ────────────────────────────────────────────────────

let redisClient: Redis | null | undefined;
function getRedis(): Redis | null {
  if (redisClient !== undefined) return redisClient;
  // Accepts BOTH the UPSTASH_* and the KV_* naming — the Vercel Marketplace
  // provisions the latter, so gating on Redis.fromEnv()'s UPSTASH_* names alone
  // meant a correctly-installed integration still left every lock per-instance.
  const cfg = resolveRedisRestConfig();
  if (cfg) {
    try {
      redisClient = new Redis(cfg);
    } catch (err) {
      console.error("[lock] Upstash client init failed — falling back to a PER-INSTANCE lock:", err);
      redisClient = null;
    }
  } else {
    // Loud, once: silent degradation here is what made lost updates invisible.
    console.warn(
      "[lock] No Upstash REST credentials (UPSTASH_REDIS_REST_* or KV_REST_API_*). " +
      "Locks are PER-INSTANCE only — concurrent writes across lambdas can lose updates."
    );
    redisClient = null;
  }
  return redisClient;
}

/** True when a cross-instance lock (Upstash Redis) is available. */
export function isDistributedLock(): boolean {
  return getRedis() !== null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── In-process fallback: one promise chain per key ─────────────────────────────

const chains = new Map<string, Promise<unknown>>();

async function withLocalLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  // The next holder waits for prev to settle, then runs fn.
  const run = prev.catch(() => undefined).then(fn);
  chains.set(key, run);
  try {
    return await run;
  } finally {
    // Clear only if we're the tail, so the map doesn't grow unbounded.
    if (chains.get(key) === run) chains.delete(key);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface LockOptions {
  /** Lock TTL — auto-released if the holder dies. Default 5s. */
  ttlMs?: number;
  /** Acquire attempts before giving up. Default 30. */
  retries?: number;
  /** Wait between attempts. Default 100ms. */
  waitMs?: number;
}

/**
 * Run `fn` while holding a lock on `key`. Releases the lock afterwards (or on
 * TTL expiry if the instance dies mid-flight). Throws if the lock can't be
 * acquired within the retry budget.
 */
export async function withLock<T>(key: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const r = getRedis();
  if (!r) return withLocalLock(key, fn);

  const lockKey = `lock:${key}`;
  const token = crypto.randomUUID();
  const ttlMs = opts.ttlMs ?? 5000;
  const retries = opts.retries ?? 30;
  const waitMs = opts.waitMs ?? 100;

  let acquired = false;
  for (let i = 0; i < retries; i++) {
    // SET key token NX PX ttl — atomic acquire.
    const ok = await r.set(lockKey, token, { nx: true, px: ttlMs });
    if (ok === "OK") {
      acquired = true;
      break;
    }
    await sleep(waitMs);
  }
  if (!acquired) {
    throw new Error(`[lock] could not acquire ${key} after ${retries} attempts`);
  }

  try {
    return await fn();
  } finally {
    // Release only if we still hold the token (don't delete someone else's lock
    // if ours already expired). Best-effort — TTL bounds any leak.
    try {
      const current = await r.get<string>(lockKey);
      if (current === token) await r.del(lockKey);
    } catch {
      /* TTL will clean up */
    }
  }
}
