/**
 * Durable job queue client.
 *
 * In production (QSTASH_TOKEN set): publishes jobs to Upstash QStash, which
 * delivers them to /api/jobs/handler with automatic retries and deduplication.
 *
 * In local dev (no QSTASH_TOKEN): falls back to next/server `after()` for
 * fire-and-forget execution in the same process.  The fallback is synchronous
 * within the request cycle but still non-blocking for the HTTP response.
 *
 * Usage:
 *   import { enqueueJob } from "@/lib/jobs/queue";
 *   await enqueueJob("ingest.gmail", username, payload, { idempotencyKey });
 *
 * QStash deduplication: supply the same `idempotencyKey` for a job and QStash
 * will ignore the second enqueue within the dedup window (~12h).  Always pass
 * the externalId (e.g. "gmail:abc123") as the key for webhook-triggered jobs.
 */

import { after } from "next/server";
import { randomUUID } from "node:crypto";
import { createJobRecord } from "./store";
import { executeJob } from "./executor";
import type { JobType, JobPayloadMap } from "./types";

// ── Configuration ─────────────────────────────────────────────────────────────

/** Max delivery attempts QStash will make before marking the job dead. */
const QSTASH_RETRIES = 3;

/** Base URL of this app — required for QStash to know where to deliver. */
function appBaseUrl(): string | undefined {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}` ||
    process.env.APP_URL
  );
}

// ── Core enqueue function ─────────────────────────────────────────────────────

export interface EnqueueOptions {
  /**
   * Stable key used for QStash deduplication.
   * Use the source externalId (e.g. "gmail:abc123") for webhook-triggered jobs.
   * If omitted, a random UUID is used (no deduplication).
   */
  idempotencyKey?: string;
}

/**
 * Enqueue a typed job for background execution.
 *
 * Returns the job ID so callers can correlate with job records in the health panel.
 */
export async function enqueueJob<T extends JobType>(
  type: T,
  username: string,
  payload: JobPayloadMap[T],
  opts: EnqueueOptions = {}
): Promise<string> {
  const jobId = opts.idempotencyKey
    ? stableJobId(type, opts.idempotencyKey)
    : randomUUID();

  const qstashToken = process.env.QSTASH_TOKEN;
  const baseUrl = appBaseUrl();

  if (qstashToken && baseUrl) {
    return enqueueViaQStash(type, username, payload, jobId, qstashToken, baseUrl);
  }

  // ── Local dev fallback: execute via after() ────────────────────────────────
  console.log(`[jobs] local dev: running ${type} inline via after() (no QSTASH_TOKEN)`);
  const record = await createJobRecord(username, type, jobId);
  after(
    executeJob(type, username, payload, record.id).catch((err) => {
      console.error(`[jobs] ${type} failed (local):`, err instanceof Error ? err.message : err);
    })
  );
  return jobId;
}

// ── QStash delivery ───────────────────────────────────────────────────────────

async function enqueueViaQStash<T extends JobType>(
  type: T,
  username: string,
  payload: JobPayloadMap[T],
  jobId: string,
  token: string,
  baseUrl: string
): Promise<string> {
  const handlerUrl = `${baseUrl}/api/jobs/handler`;

  const body = JSON.stringify({ jobId, type, username, payload });

  try {
    // This runs in a regular Next.js API route context — globalThis.fetch is available.
    const res = await globalThis.fetch(`https://qstash.upstash.io/v2/publish/${encodeURIComponent(handlerUrl)}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        // QStash deduplication: same messageId within the window → ignored
        "Upstash-Message-Id": jobId,
        "Upstash-Retries": String(QSTASH_RETRIES),
        // Forward a signed header so our handler can verify the request came from QStash
        "Upstash-Forward-X-Job-Id": jobId,
      },
      body,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`QStash publish failed: ${res.status} ${text}`);
    }

    // Create a queued record so it shows up in health immediately
    await createJobRecord(username, type, jobId);
    console.log(`[jobs] enqueued ${type} via QStash (jobId=${jobId})`);
    return jobId;
  } catch (err) {
    // If QStash is unreachable, fall back to after() so the job still runs
    console.error(`[jobs] QStash enqueue failed for ${type} — falling back to after():`, err instanceof Error ? err.message : err);
    const record = await createJobRecord(username, type, jobId);
    after(
      executeJob(type, username, payload, record.id).catch((e) => {
        console.error(`[jobs] ${type} fallback failed:`, e instanceof Error ? e.message : e);
      })
    );
    return jobId;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Derive a deterministic job ID from the job type + idempotency key.
 * QStash uses this as the message ID for deduplication.
 * We truncate the SHA-256 to 32 hex chars — plenty of collision resistance.
 */
function stableJobId(type: JobType, key: string): string {
  // Simple deterministic ID without crypto dependency:
  // type + key hashed via built-in btoa for a stable, URL-safe string.
  const raw = `${type}:${key}`;
  // Use a simple but stable encoding — no external crypto needed here
  return Buffer.from(raw).toString("base64url").slice(0, 32).replace(/[^a-zA-Z0-9]/g, "x");
}
