/**
 * Persistent file store — production-grade, durable, no env-var snapshots.
 *
 * Architecture
 * ────────────
 * Two layers:
 *
 *  L1 — /tmp filesystem (or .data/ locally)
 *       Fast synchronous-speed reads after first access.
 *       Dies on cold start (Vercel /tmp is ephemeral per instance).
 *
 *  L2 — Vercel Blob  (when BLOB_READ_WRITE_TOKEN is set)
 *       Durable object storage, survives cold starts and redeployments.
 *       Falls back to filesystem-only when the token is absent (local dev).
 *
 * Read path:   /tmp hit → return fast
 *              /tmp miss → fetch from Blob → populate /tmp → return
 *
 * Write path:  write to /tmp (synchronous-speed)
 *              enqueue async Blob write (durable, fire-and-forget by default)
 *
 * forceFlushBlob (exported as forceFlushSnapshot for back-compat):
 *   Awaits all queued Blob writes before returning. Call this in API routes
 *   that write auth tokens or critical settings to guarantee the write landed
 *   in Blob before the response is sent.
 *
 * Migration
 * ─────────
 * On first cold start with Blob enabled, if a BASIL_DATA env-var snapshot
 * exists AND the migration sentinel (basil/_migrated) does not, we parse
 * BASIL_DATA and write every file to Blob. This runs once and is idempotent.
 * After migration BASIL_DATA is permanently ignored.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./paths";
import {
  blobReadJson,
  blobWriteJson,
  blobDeleteJson,
  blobListJson,
  blobMigrateFromSnapshot,
  blobIsMigrated,
} from "./adapters/blob";
import {
  fsReadJson,
  fsWriteJson,
  fsDeleteJson,
  fsListJson,
} from "./adapters/filesystem";
import {
  envReadJson,
  envWriteJson,
  envDeleteJson,
  envListJson,
  envFlush,
  isVercelEnvAdapterAvailable,
} from "./adapters/vercel-env";

// ── Backend selection ─────────────────────────────────────────────────────────
//
// Priority:
//  1. Vercel Blob  — when BLOB_READ_WRITE_TOKEN is set (durable object storage)
//  2. Vercel Env   — when VERCEL_TOKEN + credentials are set (BASIL_DATA snapshot)
//  3. Local FS     — local dev / fallback
//
// The Vercel Env adapter survives cold starts because it reads from the env var
// on each new instance. Writes are propagated back via the Vercel API so future
// cold starts get the latest snapshot.

/** True when Vercel Blob is configured (production). */
function isBlobEnabled(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

/** True when the Vercel Env (BASIL_DATA) adapter can be used. */
function isEnvEnabled(): boolean {
  return !isBlobEnabled() && isVercelEnvAdapterAvailable();
}

// ── Migration (runs once per cold start if needed) ───────────────────────────

let migrationRan = false;

/**
 * If BASIL_DATA exists and Blob hasn't been seeded yet, migrate all files
 * from the snapshot into Blob. Safe to call on every cold start — the
 * migration sentinel prevents it from running more than once.
 */
async function maybeRunMigration(): Promise<void> {
  if (migrationRan) return;
  migrationRan = true;

  // Blob migration: only runs when Blob is configured
  if (!isBlobEnabled()) return;
  if (!process.env.BASIL_DATA) return;

  try {
    // Fast exit if we've already migrated in a previous deployment
    const alreadyMigrated = await blobIsMigrated();
    if (alreadyMigrated) return;

    const raw = process.env.BASIL_DATA;
    const snap = JSON.parse(
      Buffer.from(raw, "base64").toString("utf8")
    ) as Record<string, unknown>;

    if (Object.keys(snap).length === 0) return;

    await blobMigrateFromSnapshot(snap);
  } catch (err) {
    console.error(
      "[storage] BASIL_DATA migration failed:",
      err instanceof Error ? err.message : err
    );
    // Non-fatal — continue with whatever data is available
  }
}

// ── /tmp write-through cache helpers ────────────────────────────────────────

async function tmpPath(scope: string, key: string): Promise<string> {
  const dir = scope ? path.join(DATA_DIR, scope) : DATA_DIR;
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, key);
}

async function tmpWrite<T>(scope: string, key: string, data: T): Promise<void> {
  const p = await tmpPath(scope, key);
  await fs.writeFile(p, JSON.stringify(data, null, 2), "utf8");
}

// Sentinel to detect "not in /tmp" without confusing with a valid `null` value
const NOT_FOUND = Symbol("NOT_FOUND");

async function tmpReadOrMiss<T>(
  scope: string,
  key: string
): Promise<T | typeof NOT_FOUND> {
  try {
    const p = await tmpPath(scope, key);
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return NOT_FOUND;
  }
}

// ── Blob write queue ─────────────────────────────────────────────────────────
//
// Blob writes are serialised through a promise chain so that concurrent
// writeStore calls don't race on the Blob service. Each write chains onto the
// previous, then captures a snapshot of pending writes — effectively batching
// writes that arrive while a previous write is in flight.

let blobChain: Promise<void> = Promise.resolve();

function enqueueBlobWrite<T>(scope: string, key: string, data: T): void {
  blobChain = blobChain
    .catch(() => undefined) // don't let a prior failure stall the queue
    .then(() => blobWriteJson(scope, key, data));
  // NOTE: we deliberately do NOT catch() the write itself here.
  // For "eventual" durability callers, the error stays on blobChain but doesn't
  // propagate (the caller never awaits it). For "strong" durability callers,
  // the await below will surface the error so the API route returns a 500 instead
  // of silently losing data.
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Read a JSON file from the store.
 *
 * @param filename  Filename, e.g. "sage-memory.json"
 * @param fallback  Value returned when the file doesn't exist or is corrupt
 * @param subdir    Optional subdirectory, e.g. "users/michael"
 */
export async function readStore<T>(
  filename: string,
  fallback: T,
  subdir?: string,
  options?: { fresh?: boolean }
): Promise<T> {
  const scope = subdir ?? "";

  // Run migration once (no-op on subsequent calls or if already done)
  await maybeRunMigration();

  if (!isBlobEnabled() && !isEnvEnabled()) {
    // Local dev: filesystem only
    return fsReadJson(scope, filename, fallback);
  }

  if (isEnvEnabled()) {
    // Vercel Env adapter: in-memory snapshot (populated from BASIL_DATA on cold start)
    return envReadJson(scope, filename, fallback);
  }

  // Blob: try /tmp cache first (fast path) — unless fresh=true (security-critical reads)
  if (!options?.fresh) {
    const cached = await tmpReadOrMiss<T>(scope, filename);
    if (cached !== NOT_FOUND) return cached as T;
  }

  // /tmp miss (or bypassed) — fetch from Blob and populate the cache
  const data = await blobReadJson(scope, filename, fallback);
  if (data !== fallback) {
    // Only cache if we got real data (don't cache the fallback sentinel)
    await tmpWrite(scope, filename, data).catch(() => undefined);
  }
  return data;
}

/**
 * Write a JSON value to the store.
 *
 * Always writes to /tmp immediately (fast). Enqueues an async Blob write
 * for durability. On local dev, writes to the filesystem only.
 *
 * @param filename    Filename, e.g. "sage-memory.json"
 * @param data        JSON-serialisable value
 * @param subdir      Optional subdirectory, e.g. "users/michael"
 * @param options.durability
 *   "strong"   — await Blob persistence before returning. Use for all
 *                user-mutating writes (auth tokens, actions, decisions,
 *                memory, contacts, settings) so the response is never sent
 *                before the write has landed durably.
 *   "eventual" — fire-and-forget Blob write (default). Suitable for
 *                generated cache files (briefing, digest) where a cold-start
 *                miss is acceptable.
 */
export async function writeStore<T>(
  filename: string,
  data: T,
  subdir?: string,
  options?: { durability?: "eventual" | "strong" }
): Promise<void> {
  const scope = subdir ?? "";
  const durability = options?.durability ?? "eventual";

  if (!isBlobEnabled() && !isEnvEnabled()) {
    // Local dev: filesystem only (sync, no queue needed)
    return fsWriteJson(scope, filename, data);
  }

  if (isEnvEnabled()) {
    // Vercel Env adapter: synchronous in-memory write + async API persistence.
    // envFlush() never throws — persistence failures are logged, not propagated.
    envWriteJson(scope, filename, data);
    if (durability === "strong") {
      const { error } = await envFlush();
      if (error) {
        // Log but do not throw: data is in memory, cold-start recovery may be
        // impaired but the current request should succeed.
        console.warn(`[storage] env-snapshot persist warning: ${error}`);
      }
    }
    return;
  }

  // Blob path
  // Write to /tmp immediately for fast subsequent reads
  await tmpWrite(scope, filename, data);

  // Enqueue durable Blob write
  enqueueBlobWrite(scope, filename, data);

  if (durability === "strong") {
    // Await all pending Blob writes (including the one just enqueued).
    // This guarantees the write has landed before the caller continues.
    // Errors are intentionally NOT swallowed here — they propagate to the
    // caller so the API route can return a 500 instead of silently losing data.
    await blobChain;
  } else {
    console.info(
      `[storage] eventual write queued: ${scope ? scope + "/" : ""}${filename}`
    );
  }
}

/**
 * Delete a JSON file from the store.
 *
 * @param filename  Filename to delete
 * @param subdir    Optional subdirectory
 */
export async function deleteStore(
  filename: string,
  subdir?: string
): Promise<void> {
  const scope = subdir ?? "";

  if (!isBlobEnabled() && !isEnvEnabled()) {
    return fsDeleteJson(scope, filename);
  }

  if (isEnvEnabled()) {
    envDeleteJson(scope, filename);
    return;
  }

  // Remove from /tmp
  const p = await tmpPath(scope, filename);
  await fs.unlink(p).catch(() => undefined);

  // Remove from Blob
  await blobDeleteJson(scope, filename);
}

/**
 * List all JSON filenames in a directory scope.
 *
 * @param subdir  Optional subdirectory, e.g. "users/michael"
 */
export async function listStore(subdir?: string): Promise<string[]> {
  const scope = subdir ?? "";

  if (!isBlobEnabled() && !isEnvEnabled()) {
    return fsListJson(scope);
  }

  if (isEnvEnabled()) {
    return envListJson(scope);
  }

  return blobListJson(scope);
}

/**
 * Await all in-flight Blob writes.
 *
 * Renamed from forceFlushSnapshot but kept under the old name for
 * backwards compatibility with all existing call sites. With Blob storage,
 * individual writes are already durable — this just ensures they've landed
 * before the response is sent (useful for auth token saves, account creation,
 * etc. where we need the write committed before the function instance exits).
 *
 * In local dev (no Blob), this is a no-op.
 */
export async function forceFlushSnapshot(): Promise<{ ok: boolean; errors: string[] }> {
  try {
    if (isEnvEnabled()) {
      const { ok, error } = await envFlush();
      return { ok, errors: error ? [error] : [] };
    }
    if (isBlobEnabled()) {
      await blobChain;
      return { ok: true, errors: [] };
    }
    return { ok: true, errors: [] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[storage] forceFlushSnapshot failed:", msg);
    return { ok: false, errors: [msg] };
  }
}

// ── Legacy / compatibility exports ──────────────────────────────────────────

/**
 * @deprecated No-op. Snapshot diagnostics no longer exist — Blob writes are
 * always durable and don't require a separate health check. Kept to avoid
 * breaking any dashboard routes that import this.
 */
export interface SnapshotDiagnostics {
  isConfigured: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
  payloadBytes: number | null;
}

/**
 * @deprecated Returns a static object. With Blob storage, durability is
 * handled by the Blob service — no separate snapshot diagnostics needed.
 */
export function getSnapshotDiagnostics(): SnapshotDiagnostics {
  return {
    isConfigured: isBlobEnabled(),
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureReason: null,
    payloadBytes: null,
  };
}
