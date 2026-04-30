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

// In-flight snapshot serialization: we chain onto this promise so that
// concurrent writeStore calls don't fire overlapping Vercel API writes.
// Each snapshot waits for the previous one to complete, then takes a fresh
// read of DATA_DIR — capturing all writes that happened in between.
let snapshotChain: Promise<void> = Promise.resolve();

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
  // isConfigured: check env vars directly — don't rely on the module-level flag
  // which starts as false and only updates after the first write in this instance.
  const token     = process.env.VERCEL_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  return {
    ...snapDiag,
    isConfigured: !!(token && projectId),
  };
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
    const keys = Object.keys(snapshot);
    await Promise.all(
      Object.entries(snapshot).map(async ([key, data]) => {
        // Keys may now be paths like "users/michael/sage-memory.json" — create parent dirs
        const dest = path.join(DATA_DIR, key);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, JSON.stringify(data, null, 2), "utf8");
      })
    );
    console.log(`[snapshot] Restored ${keys.length} store file(s) from BASIL_DATA: ${keys.join(", ")}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[snapshot] Cold-start restore failed: ${reason}. Starting with empty stores.`);
    // Don't propagate — continue with empty /tmp dir
  }
}

/** Push all .json files in DATA_DIR into the BASIL_DATA env var via Vercel API. */
async function persistSnapshot(): Promise<void> {
  if (!process.env.VERCEL) return; // local dev uses the real filesystem

  // Ensure the cold-start restore has run before we take a snapshot.
  // Without this, a writeStore call on a fresh instance (e.g. OAuth callback)
  // would snapshot an empty /tmp — wiping all existing data from BASIL_DATA.
  await maybeRestore();

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
    //
    // Files hard-excluded from BASIL_DATA regardless of payload size.
    // Excluded = too large OR safely re-derivable on next warm request:
    //   whatsapp-snapshot.json  — can be 100s of KB; re-run dump to regenerate
    //   sage-events.json        — audit/signal log; grows unboundedly
    const SNAPSHOT_EXCLUDE = new Set([
      "whatsapp-snapshot.json",
      "sage-events.json",
    ]);

    // Auth + config files that must ALWAYS be in the snapshot — these are what
    // make Basil functional on a cold start. They're small and not re-derivable.
    const CRITICAL_FILES = new Set([
      "google-tokens.json",
      "slack-config.json",
      "linear-config.json",
      "microsoft-tokens.json",
      "sage-settings.json",
    ]);

    // Hard ceiling for the base64 payload.
    // Vercel encrypts env vars individually; their documented limit is 64KB per
    // var. Other vars (tokens, secrets) use ~12KB, so cap BASIL_DATA at 44KB —
    // conservative headroom that survives future secret additions.
    const PAYLOAD_HARD_CAP = 44_000;

    // Priority order for dropping files when still over cap after exclusions.
    // Lower index = dropped first. Files not in this list and not in CRITICAL_FILES
    // are never auto-dropped (they'll cause a skip if they push us over cap).
    // On-disk files are NEVER modified — this only affects the BASIL_DATA backup.
    const DROP_PRIORITY = [
      "sage-user-contacts.json",   // large; fully re-derivable from Google/Slack/MS
      "sage-memory.json",          // memories can be partially re-derived from signals
      "sage-actions.json",         // actions re-ingest from email/Slack on next poll
      "sage-decisions.json",       // last resort — important but survives temporary loss
    ];

    /**
     * Recursively collect all JSON files under a directory.
     * Returns entries as { key: relative-path-from-DATA_DIR, absPath }.
     */
    async function collectJsonFiles(dir: string, relBase = ""): Promise<Array<{ key: string; absPath: string }>> {
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch {
        return [];
      }
      const results: Array<{ key: string; absPath: string }> = [];
      for (const entry of entries) {
        const absPath = path.join(dir, entry);
        const relPath = relBase ? `${relBase}/${entry}` : entry;
        let stat: Awaited<ReturnType<typeof fs.stat>>;
        try {
          stat = await fs.stat(absPath);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          const nested = await collectJsonFiles(absPath, relPath);
          results.push(...nested);
        } else if (entry.endsWith(".json") && !SNAPSHOT_EXCLUDE.has(entry)) {
          results.push({ key: relPath, absPath });
        }
      }
      return results;
    }

    const allFiles = await collectJsonFiles(DATA_DIR);

    const snapshot: Record<string, unknown> = {};
    for (const { key, absPath } of allFiles) {
      try {
        const raw = await fs.readFile(absPath, "utf8");
        snapshot[key] = JSON.parse(raw);
      } catch {
        console.warn(`[snapshot] Skipping unreadable file: ${key}`);
      }
    }

    let encoded      = Buffer.from(JSON.stringify(snapshot)).toString("base64");
    let payloadBytes = encoded.length;

    // ── Hard-cap enforcement ─────────────────────────────────────────────────
    // If still over budget after exclusions, drop low-priority files one by one
    // until we fit. On-disk files are untouched — only the backup is affected.
    if (payloadBytes > PAYLOAD_HARD_CAP) {
      const dropped: string[] = [];
      for (const basename of DROP_PRIORITY) {
        if (payloadBytes <= PAYLOAD_HARD_CAP) break;
        // Match by basename (file may live in a subdir)
        const matchKey = Object.keys(snapshot).find(
          (k) => k === basename || k.endsWith(`/${basename}`)
        );
        if (matchKey) {
          delete snapshot[matchKey];
          encoded      = Buffer.from(JSON.stringify(snapshot)).toString("base64");
          payloadBytes = encoded.length;
          dropped.push(matchKey);
        }
      }
      if (dropped.length > 0) {
        console.warn(`[snapshot] Dropped ${dropped.join(", ")} to fit under ${PAYLOAD_HARD_CAP}B cap.`);
      }
    }

    // If STILL over cap after all drops, fall back to critical-only snapshot.
    // Auth tokens and settings must always be persisted — losing them causes
    // integrations to appear disconnected on every cold start.
    if (payloadBytes > PAYLOAD_HARD_CAP) {
      const nonCritical = Object.keys(snapshot).filter(
        (k) => !CRITICAL_FILES.has(k) && !Array.from(CRITICAL_FILES).some((c) => k.endsWith(`/${c}`))
      );
      for (const key of nonCritical) delete snapshot[key];
      encoded      = Buffer.from(JSON.stringify(snapshot)).toString("base64");
      payloadBytes = encoded.length;
      console.warn(
        `[snapshot] Still over cap — trimmed to critical-only (${Object.keys(snapshot).join(", ")}). ` +
        `Payload: ${payloadBytes}B`
      );
    }

    if (payloadBytes > PAYLOAD_WARN_BYTES) {
      console.warn(`[snapshot] Payload is ${payloadBytes}B — approaching ${PAYLOAD_WARN_BYTES}B warn threshold.`);
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

export async function readStore<T>(filename: string, fallback: T, subdir?: string): Promise<T> {
  await maybeRestore();
  await ensureDir();
  const dir = subdir ? path.join(DATA_DIR, subdir) : DATA_DIR;
  try {
    const raw    = await fs.readFile(path.join(dir, filename), "utf8");
    const parsed = JSON.parse(raw);
    return (Array.isArray(fallback) ? (Array.isArray(parsed) ? parsed : fallback) : parsed) as T;
  } catch {
    return fallback;
  }
}

export async function writeStore<T>(filename: string, data: T, subdir?: string): Promise<void> {
  await ensureDir();
  const dir = subdir ? path.join(DATA_DIR, subdir) : DATA_DIR;
  if (subdir) await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), JSON.stringify(data, null, 2), "utf8");
  // Serialize snapshot writes: chain onto the previous in-flight snapshot so
  // concurrent writeStore calls don't race each other on the Vercel API.
  // Each snapshot waits for the prior one, then reads the current state of
  // DATA_DIR — capturing every write that landed while we were waiting.
  snapshotChain = snapshotChain
    .catch(() => undefined) // don't let a prior failure block the queue
    .then(() => persistSnapshot())
    .catch((err) => { console.error("[snapshot] Unexpected error in persistSnapshot:", err); });
}

/**
 * Explicitly awaits a snapshot flush.
 *
 * Call this at the end of after() callbacks (poll-ingest, reprocess, etc.)
 * to guarantee BASIL_DATA is updated before Vercel recycles the function.
 * Unlike the fire-and-forget in writeStore, this awaits completion.
 */
export async function forceFlushSnapshot(): Promise<void> {
  // Wait for any queued writes to drain first, then do one final flush.
  await snapshotChain.catch(() => undefined);
  await persistSnapshot();
}
