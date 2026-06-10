/**
 * lib/storage/adapters/postgres.ts — durable Postgres backend (activation-ready).
 *
 * The flat-file-on-Blob store is correct (with Phase 1 locking) but has a scale
 * ceiling: whole-file JSON, no transactions, a per-instance /tmp cache that can
 * serve stale data. This adapter slots a real transactional database under the
 * same storage abstraction.
 *
 * Model: a single key-value table mapping (scope, key) → jsonb, mirroring the
 * existing scope/filename → JSON layout, so NOTHING above the storage layer
 * changes. Read-modify-write atomicity continues to come from lib/storage/lock.
 *
 * ACTIVATION (owner step): provision Postgres (Neon via the Vercel Marketplace
 * is the recommended path) and set DATABASE_URL. Until then this is inert —
 * getPool() returns null and persistent.ts uses Blob / filesystem exactly as
 * before. After setting DATABASE_URL, validate reads/writes against your own
 * database before relying on it; this code path cannot be exercised locally
 * without a Postgres instance.
 *
 * server-only.
 */

import "server-only";
import { Pool } from "pg";

let pool: Pool | null | undefined;

function getPool(): Pool | null {
  if (pool !== undefined) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) {
    pool = null;
    return null;
  }
  pool = new Pool({
    connectionString: url,
    max: 5,
    // Most managed Postgres (Neon, Supabase, RDS) require TLS. Allow opting out
    // for a local plaintext instance with PGSSL=disable.
    ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
  });
  return pool;
}

/** True when DATABASE_URL is configured (Postgres is the durable backend). */
export function isPostgresEnabled(): boolean {
  return getPool() !== null;
}

let schemaReady: Promise<void> | null = null;
async function ensureSchema(p: Pool): Promise<void> {
  if (!schemaReady) {
    schemaReady = p
      .query(
        `CREATE TABLE IF NOT EXISTS basil_store (
           scope      text NOT NULL,
           key        text NOT NULL,
           data       jsonb NOT NULL,
           updated_at timestamptz NOT NULL DEFAULT now(),
           PRIMARY KEY (scope, key)
         )`
      )
      .then(() => undefined)
      .catch((err) => {
        schemaReady = null; // allow a retry on the next call
        throw err;
      });
  }
  return schemaReady;
}

export async function pgReadJson<T>(scope: string, key: string, fallback: T): Promise<T> {
  const p = getPool();
  if (!p) return fallback;
  await ensureSchema(p);
  const res = await p.query<{ data: unknown }>(
    "SELECT data FROM basil_store WHERE scope = $1 AND key = $2",
    [scope, key]
  );
  if (res.rows.length === 0) return fallback;
  const data = res.rows[0].data;
  return (Array.isArray(fallback) ? (Array.isArray(data) ? data : fallback) : data) as T;
}

export async function pgWriteJson<T>(scope: string, key: string, data: T): Promise<void> {
  const p = getPool();
  if (!p) return;
  await ensureSchema(p);
  await p.query(
    `INSERT INTO basil_store (scope, key, data, updated_at)
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (scope, key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [scope, key, JSON.stringify(data)]
  );
}

export async function pgDeleteJson(scope: string, key: string): Promise<void> {
  const p = getPool();
  if (!p) return;
  await ensureSchema(p);
  await p.query("DELETE FROM basil_store WHERE scope = $1 AND key = $2", [scope, key]);
}

export async function pgListJson(scope: string): Promise<string[]> {
  const p = getPool();
  if (!p) return [];
  await ensureSchema(p);
  const res = await p.query<{ key: string }>(
    "SELECT key FROM basil_store WHERE scope = $1",
    [scope]
  );
  return res.rows.map((r) => r.key);
}

/** Delete every row under a user's scope prefix — for GDPR account purge. */
export async function pgPurgeUserData(username: string): Promise<number> {
  const p = getPool();
  if (!p) return 0;
  await ensureSchema(p);
  const safe = username.replace(/[^a-zA-Z0-9._-]/g, "_");
  // user-scoped files live under scope "users/<safe>" (and exactly that scope).
  const res = await p.query("DELETE FROM basil_store WHERE scope = $1 OR scope LIKE $2", [
    `users/${safe}`,
    `users/${safe}/%`,
  ]);
  return res.rowCount ?? 0;
}
