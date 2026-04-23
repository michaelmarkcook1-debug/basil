/**
 * Persistent file store that works on both local dev and Vercel.
 *
 * Local dev: reads/writes to .data/ (gitignored, survives restarts).
 * Vercel:    reads/writes to /tmp/basil-data/ (writable by Fluid Compute).
 *            On cold start the /tmp dir is empty, so we restore from the
 *            BASIL_DATA env var (a base64-encoded JSON snapshot we write
 *            after every mutation).
 *
 * Snapshot persistence hardening:
 * - All snapshot failures are logged with console.error (never silent).
 * - Diagnostic metadata (attempt/success/failure timestamps, payload size)
 *   is tracked module-level and exposed via getSnapshotDiagnostics().
 * - HTTP errors from the Vercel API include status code + response body.
 * - Fetch calls have an 8-second timeout to prevent hanging.
 * - Payload size is checked and warned if approaching Vercel's 64KB limit.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./paths";

// ── Snapshot env var name ──────────────────────────────────────────────────
const SNAPSHOT_VAR = "BASIL_DATA";

// Vercel encrypted env vars have a limit. Warn well before hitting it.
const PAYLOAD_WARN_BYTES  = 48_000; // ~48 KB — warn threshold
const PAYLOAD_ERROR_BYTES = 60_000; // ~60 KB — likely to fail; log error

// One-time cold-start restore flag (module-level, per function instance)
let restored = false;

// ── Snapshot diagnostics ───────────────────────────────────────────────────

export interface SnapshotDiagnostics {
  /** Whether VERCEL_TOKEN + VERCEL_PROJECT_ID are configured. */
  isConfigured: boolean;
  /** ISO timestamp of the last persist attempt (null = never attempted). */
  lastAttemptAt: string | null;
  /** ISO timestamp of the last successful persist (null = never succeeded). */
  lastSuccessAt: string | null;
  /** ISO timestamp of the last failed persist (null = never failed). */
  lastFailureAt: string | null;
  /** Human-readable reason for the last failure (null = no failure). */
  lastFailureReason: string | null;
  /** Approximate size in bytes of the last successfully persisted snapshot. */
  payloadBytes: number | null;
}

const snapDiag: SnapshotDiagnostics = {
  isConfigured:      false,
  lastAttemptAt:     null,
  lastSuccessAt:     null,
  lastFailureAt:     null,
  lastFailureReason: null,
  payloadBytes:      null,
};

/**
 * Returns a shallow copy of the current snapshot diagnostics.
 * Values are per-instance (reset on cold start) — useful for real-time
 * health checks, not historical auditing.
 */
export function getSnapshotDiagnostics(): SnapshotDiagnostics {
  return { ...snapDiag };
}

// ── Internal helpers ───────────────────────────────────────────────────────

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

/** Load env-var snapshot into /tmp on cold start (Vercel only, runs once). */
async function maybeRestore(): Promise<void> {
  if (restored || !process.env.VERCEL) return;
  restored = true;

  const raw = process.env[SNAPSHOT_VAR];
  if (!raw) {
    console.log("[snapshot] No BASIL_DATA snapshot found — starting with empty stores.");
    return;
  }

  try {
    const snapshot = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as Record<string, unknown>;
    await ensureDir();
    const files = Object.keys(snapshot);
    await Promise.all(
      Object.entries(snapshot).map(([filename, data]) =>
        fs.writeFile(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2), "utf8")
      )
    );
    console.log(`[snapshot] Restored ${files.length} store file(s) from BASIL_DATA: ${files.join(", ")}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[snapshot] Cold-start restore failed: ${reason}. Starting with empty stores.`);
    // Don't propagate — continue with empty /tmp dir
  }
}

/** Push all .json files in DATA_DIR into the BASIL_DATA env var via Vercel API. */
async function persistSnapshot(): Promise<void> {
  if (!process.env.VERCEL) return; // local dev uses the real filesystem

  const now = new Date().toISOString();
  snapDiag.lastAttemptAt = now;

  const token     = process.env.VERCEL_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  const teamId    = process.env.VERCEL_TEAM_ID;

  snapDiag.isConfigured = !!(token && projectId);

  if (!token || !projectId) {
    // Only log this once per instance to avoid flooding logs on every write.
    if (!snapDiag.lastFailureReason?.startsWith("not-configured")) {
      const reason =
        "not-configured: " +
        [!token && "VERCEL_TOKEN", !projectId && "VERCEL_PROJECT_ID"]
          .filter(Boolean)
          .join(", ") +
        " missing — data will not survive cold starts";
      console.warn(`[snapshot] ${reason}`);
      snapDiag.lastFailureAt     = now;
      snapDiag.lastFailureReason = reason;
    }
    return;
  }

  try {
    // ── 1. Build snapshot ────────────────────────────────────────────────────
    let files: string[];
    try {
      files = await fs.readdir(DATA_DIR);
    } catch (err) {
      throw new Error(`readdir(${DATA_DIR}) failed: ${err instanceof Error ? err.message : err}`);
    }

    const snapshot: Record<string, unknown> = {};
    // All .json stores are included — sage-events.json is deliberately included
    // because pending event drafts awaiting approval must survive cold starts.
    for (const f of files.filter((f) => f.endsWith(".json"))) {
      try {
        const raw = await fs.readFile(path.join(DATA_DIR, f), "utf8");
        snapshot[f] = JSON.parse(raw);
      } catch {
        console.warn(`[snapshot] Skipping unreadable file: ${f}`);
      }
    }

    const encoded     = Buffer.from(JSON.stringify(snapshot)).toString("base64");
    const payloadBytes = encoded.length;

    if (payloadBytes > PAYLOAD_ERROR_BYTES) {
      console.error(
        `[snapshot] Payload is ${payloadBytes} bytes — likely exceeds Vercel's 64KB env var limit. ` +
        `Run event compaction to reduce size. ${Object.keys(snapshot).join(", ")}`
      );
    } else if (payloadBytes > PAYLOAD_WARN_BYTES) {
      console.warn(`[snapshot] Payload is ${payloadBytes} bytes — approaching the 64KB limit.`);
    }

    // ── 2. Find existing BASIL_DATA env var id ───────────────────────────────
    const teamParam = teamId ? `&teamId=${teamId}` : "";
    const listUrl   = `https://api.vercel.com/v9/projects/${projectId}/env?teamId=${teamId ?? ""}`;

    let listRes: Response;
    try {
      listRes = await fetch(listUrl, {
        headers: { Authorization: `Bearer ${token}` },
        signal:  AbortSignal.timeout(8_000),
      });
    } catch (err) {
      throw new Error(`Vercel API list request failed: ${err instanceof Error ? err.message : err}`);
    }

    if (!listRes.ok) {
      const errText = await listRes.text().catch(() => "");
      throw new Error(`Vercel API list HTTP ${listRes.status}: ${errText.slice(0, 200)}`);
    }

    const { envs } = (await listRes.json()) as { envs: Array<{ id: string; key: string }> };
    const existing  = envs.find((e) => e.key === SNAPSHOT_VAR);

    // ── 3. Write the snapshot ────────────────────────────────────────────────
    let writeRes: Response;
    try {
      if (existing) {
        writeRes = await fetch(
          `https://api.vercel.com/v9/projects/${projectId}/env/${existing.id}?teamId=${teamId ?? ""}`,
          {
            method:  "PATCH",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body:    JSON.stringify({ value: encoded, target: ["production", "preview"] }),
            signal:  AbortSignal.timeout(8_000),
          }
        );
      } else {
        writeRes = await fetch(
          `https://api.vercel.com/v9/projects/${projectId}/env?teamId=${teamId ?? ""}`,
          {
            method:  "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body:    JSON.stringify({
              key:    SNAPSHOT_VAR,
              value:  encoded,
              type:   "encrypted",
              target: ["production", "preview"],
            }),
            signal: AbortSignal.timeout(8_000),
          }
        );
      }
    } catch (err) {
      throw new Error(`Vercel API write request failed: ${err instanceof Error ? err.message : err}`);
    }

    if (!writeRes.ok) {
      const errText = await writeRes.text().catch(() => "");
      throw new Error(
        `Vercel API ${existing ? "PATCH" : "POST"} HTTP ${writeRes.status}: ${errText.slice(0, 200)}`
      );
    }

    // ── 4. Record success ────────────────────────────────────────────────────
    snapDiag.lastSuccessAt = new Date().toISOString();
    snapDiag.payloadBytes  = payloadBytes;
    console.log(
      `[snapshot] Persisted ${Object.keys(snapshot).length} file(s), ${payloadBytes} bytes` +
      ` (${Object.keys(snapshot).join(", ")})`
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    snapDiag.lastFailureAt     = new Date().toISOString();
    snapDiag.lastFailureReason = reason;
    console.error(`[snapshot] Persistence failed: ${reason}`);
    // Do NOT rethrow — a snapshot failure must never break the write operation itself.
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function readStore<T>(filename: string, fallback: T): Promise<T> {
  await maybeRestore();
  await ensureDir();
  try {
    const raw    = await fs.readFile(path.join(DATA_DIR, filename), "utf8");
    const parsed = JSON.parse(raw);
    return (Array.isArray(fallback) ? (Array.isArray(parsed) ? parsed : fallback) : parsed) as T;
  } catch {
    return fallback;
  }
}

export async function writeStore<T>(filename: string, data: T): Promise<void> {
  await ensureDir();
  await fs.writeFile(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2), "utf8");
  // Fire-and-forget snapshot — never blocks the response.
  // Failures are logged and tracked in snapDiag; they do NOT propagate.
  persistSnapshot().catch((err) => {
    // Should never reach here (persistSnapshot has its own catch), but belt-and-suspenders.
    console.error("[snapshot] Unexpected error in persistSnapshot:", err);
  });
}
