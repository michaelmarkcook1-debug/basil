/**
 * Vercel Env-var storage adapter.
 *
 * Uses the BASIL_DATA environment variable as a persistent key-value store.
 * Reads the base64-encoded JSON snapshot at cold start (from process.env),
 * caches it in-memory for warm reads, and writes updates back to the
 * Vercel API so the next cold start gets the latest snapshot.
 *
 * Shape of BASIL_DATA:
 *   base64( JSON.stringify({ "users/michael/sage-actions.json": [...], ... }) )
 *
 * Key format: "{scope}/{filename}" or "{filename}" when scope is empty.
 *
 * Write latency: ~300–600ms for the Vercel API round-trip. Writes are
 * fire-and-forget by default; callers using durability:"strong" await them.
 *
 * This adapter is activated when:
 *   - BLOB_READ_WRITE_TOKEN is absent (blob unavailable)
 *   - VERCEL_TOKEN + VERCEL_PROJECT_ID + VERCEL_TEAM_ID are present
 *   - NODE_ENV === "production"
 *
 * In local dev, the filesystem adapter is used instead.
 */

// ── In-memory snapshot ───────────────────────────────────────────────────────

type Snapshot = Record<string, unknown>;

let snapshotLoaded = false;
let snapshot: Snapshot = {};

function buildKey(scope: string, filename: string): string {
  return scope ? `${scope}/${filename}` : filename;
}

function loadSnapshot(): void {
  if (snapshotLoaded) return;
  snapshotLoaded = true;

  const raw = process.env.BASIL_DATA;
  if (!raw) return;

  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      snapshot = parsed as Snapshot;
      console.info(
        `[vercel-env] Loaded snapshot: ${Object.keys(snapshot).length} file(s)`
      );
    }
  } catch (err) {
    console.error("[vercel-env] Failed to parse BASIL_DATA snapshot:", err);
  }
}

// ── Vercel API writer ────────────────────────────────────────────────────────

/** Cache the env-var ID so we only call list() once per instance. */
let cachedEnvId: string | null | undefined = undefined; // undefined = not yet fetched

async function fetchEnvId(): Promise<string | null> {
  if (cachedEnvId !== undefined) return cachedEnvId;

  const token = process.env.VERCEL_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  const teamId = process.env.VERCEL_TEAM_ID;

  if (!token || !projectId || !teamId) {
    cachedEnvId = null;
    return null;
  }

  try {
    const url = `https://api.vercel.com/v10/projects/${projectId}/env?teamId=${teamId}&limit=100`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      console.error("[vercel-env] Failed to list env vars:", res.status);
      cachedEnvId = null;
      return null;
    }

    const data = (await res.json()) as {
      envs?: Array<{ id: string; key: string }>;
    };
    const entry = data.envs?.find((e) => e.key === "BASIL_DATA");
    cachedEnvId = entry?.id ?? null;

    if (!cachedEnvId) {
      console.warn("[vercel-env] BASIL_DATA env var not found in project");
    }

    return cachedEnvId;
  } catch (err) {
    console.error("[vercel-env] Error fetching env var list:", err);
    cachedEnvId = null;
    return null;
  }
}

/** Persist the current in-memory snapshot back to the Vercel env var. */
async function persistSnapshot(): Promise<void> {
  const token = process.env.VERCEL_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  const teamId = process.env.VERCEL_TEAM_ID;

  if (!token || !projectId || !teamId) {
    throw new Error(
      "[vercel-env] Missing VERCEL_TOKEN / VERCEL_PROJECT_ID / VERCEL_TEAM_ID"
    );
  }

  const envId = await fetchEnvId();

  // Encode snapshot
  const encoded = Buffer.from(JSON.stringify(snapshot)).toString("base64");

  if (envId) {
    // PATCH existing env var
    const url = `https://api.vercel.com/v10/projects/${projectId}/env/${envId}?teamId=${teamId}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        value: encoded,
        type: "encrypted",
        target: ["production", "preview", "development"],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `[vercel-env] PATCH BASIL_DATA failed: ${res.status} ${body}`
      );
    }
  } else {
    // POST to create env var (first time)
    const url = `https://api.vercel.com/v10/projects/${projectId}/env?teamId=${teamId}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        key: "BASIL_DATA",
        value: encoded,
        type: "encrypted",
        target: ["production", "preview", "development"],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `[vercel-env] POST BASIL_DATA failed: ${res.status} ${body}`
      );
    }

    // Invalidate cache so next call re-fetches the new ID
    cachedEnvId = undefined;
  }

  console.info(
    `[vercel-env] Snapshot persisted: ${Object.keys(snapshot).length} file(s), ${encoded.length} bytes`
  );
}

// ── Pending write queue ───────────────────────────────────────────────────────
//
// Serialise API writes to avoid concurrent PATCH races.

let writeChain: Promise<void> = Promise.resolve();

function enqueueWrite(): void {
  writeChain = writeChain
    .catch(() => undefined) // don't let previous failure block the queue
    .then(() => persistSnapshot());
}

// ── Public adapter API ────────────────────────────────────────────────────────

export function envReadJson<T>(scope: string, key: string, fallback: T): T {
  loadSnapshot();
  const k = buildKey(scope, key);
  const val = snapshot[k];
  if (val === undefined) return fallback;
  if (Array.isArray(fallback) && !Array.isArray(val)) return fallback;
  return val as T;
}

export function envWriteJson<T>(scope: string, key: string, data: T): void {
  loadSnapshot();
  const k = buildKey(scope, key);
  snapshot[k] = data;
  enqueueWrite();
}

export function envDeleteJson(scope: string, key: string): void {
  loadSnapshot();
  const k = buildKey(scope, key);
  delete snapshot[k];
  enqueueWrite();
}

export function envListJson(scope: string): string[] {
  loadSnapshot();
  const prefix = scope ? `${scope}/` : "";
  return Object.keys(snapshot)
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length))
    .filter((rel) => rel && !rel.includes("/")); // direct children only
}

/** Await all in-flight env-var writes. */
export async function envFlush(): Promise<void> {
  await writeChain;
}

/** True when this adapter can operate (has Vercel API credentials). */
export function isVercelEnvAdapterAvailable(): boolean {
  return !!(
    process.env.VERCEL_TOKEN &&
    process.env.VERCEL_PROJECT_ID &&
    process.env.VERCEL_TEAM_ID &&
    process.env.NODE_ENV === "production"
  );
}
