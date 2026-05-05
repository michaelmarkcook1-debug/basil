/**
 * Job store — per-user circular buffer for job visibility in the health panel.
 *
 * Only the last MAX_JOB_RECORDS job records are kept.  This is intentionally
 * a best-effort audit trail, not the authoritative queue state (QStash owns
 * that in production).  The store lets the health panel surface:
 *   - Recent failed jobs that need attention
 *   - Historical throughput (how many jobs ran today)
 *   - Whether the job handler is being called at all
 *
 * Storage: sage-job-records.json per user.
 */

import { randomUUID } from "node:crypto";
import { readUserStore, writeUserStore } from "@/lib/storage/user-store";
import { withLock } from "@/lib/events/lock";
import type { JobRecord, JobStatus, JobType } from "./types";

export const JOB_RECORDS_FILE = "sage-job-records.json";
const MAX_JOB_RECORDS = 1_000;

function lockKey(username: string): string {
  return `job-records:${username}`;
}

async function readAll(username: string): Promise<JobRecord[]> {
  return readUserStore<JobRecord[]>(username, JOB_RECORDS_FILE, []);
}

// ── Public write API ───────────────────────────────────────────────────────────

/** Create a new job record and persist it. Returns the created record. */
export async function createJobRecord(
  username: string,
  type: JobType,
  id?: string
): Promise<JobRecord> {
  const now = new Date().toISOString();
  const record: JobRecord = {
    id: id ?? randomUUID(),
    type,
    username,
    status: "queued",
    attempts: 0,
    createdAt: now,
  };

  // Non-blocking: failures never surface to caller
  try {
    await withLock(lockKey(username), async () => {
      const existing = await readAll(username);
      const next = [record, ...existing].slice(0, MAX_JOB_RECORDS);
      await writeUserStore(username, JOB_RECORDS_FILE, next);
    });
  } catch (err) {
    console.error("[job-store] createJobRecord failed:", err instanceof Error ? err.message : err);
  }

  return record;
}

/** Transition a job to a new status and persist the update. Fire-and-forget safe. */
export async function updateJobRecord(
  username: string,
  jobId: string,
  patch: Partial<Pick<JobRecord, "status" | "attempts" | "lastError" | "updatedAt" | "finishedAt">>
): Promise<void> {
  try {
    await withLock(lockKey(username), async () => {
      const records = await readAll(username);
      const idx = records.findIndex((r) => r.id === jobId);
      if (idx === -1) return; // may have been evicted from the circular buffer
      records[idx] = { ...records[idx], ...patch };
      await writeUserStore(username, JOB_RECORDS_FILE, records);
    });
  } catch (err) {
    console.error("[job-store] updateJobRecord failed:", err instanceof Error ? err.message : err);
  }
}

// ── Public read API ────────────────────────────────────────────────────────────

/** List job records, newest first. */
export async function listJobRecords(
  username: string,
  opts: { limit?: number; status?: JobStatus; type?: JobType } = {}
): Promise<JobRecord[]> {
  const all = await readAll(username);
  let result = all;
  if (opts.status) result = result.filter((r) => r.status === opts.status);
  if (opts.type) result = result.filter((r) => r.type === opts.type);
  return result.slice(0, opts.limit ?? 200);
}

/** Summary counts for the health panel. */
export interface JobSummary {
  total: number;
  succeeded: number;
  failed: number;
  dead: number;
  running: number;
  queued: number;
  /** ISO timestamp of the most recently created job. */
  lastJobAt?: string;
  /** The most recent failed/dead job records (up to 5). */
  recentFailures: JobRecord[];
}

export async function getJobSummary(username: string): Promise<JobSummary> {
  const records = await readAll(username);
  const summary: JobSummary = {
    total: records.length,
    succeeded: 0,
    failed: 0,
    dead: 0,
    running: 0,
    queued: 0,
    lastJobAt: records[0]?.createdAt,
    recentFailures: [],
  };

  for (const r of records) {
    if (r.status === "succeeded") summary.succeeded++;
    else if (r.status === "failed") summary.failed++;
    else if (r.status === "dead") summary.dead++;
    else if (r.status === "running") summary.running++;
    else if (r.status === "queued") summary.queued++;
  }

  summary.recentFailures = records
    .filter((r) => r.status === "failed" || r.status === "dead")
    .slice(0, 5);

  return summary;
}
