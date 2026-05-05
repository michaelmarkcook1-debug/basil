/**
 * startWorkflow — thin wrapper over Workflow DevKit's `start()` that also
 * creates a job record in the local store for health panel visibility.
 *
 * The job record is best-effort. The Workflow runtime's own observability
 * (`npx workflow web`) is authoritative for run status and retry history.
 */
import { start } from "workflow/api";
import { randomUUID } from "node:crypto";
import { createJobRecord } from "./store";
import type { JobType, JobPayloadMap } from "./types";

export interface StartWorkflowOptions {
  /**
   * Stable key for deduplication — use the source externalId (e.g. "gmail:abc123").
   * Prevents duplicate job records when a webhook delivers the same event twice.
   */
  idempotencyKey?: string;
}

/**
 * Start a durable workflow and record a corresponding job entry.
 *
 * @param workflowFn  The exported workflow function (must have `"use workflow"`)
 * @param args        Arguments to pass: [username, payload]
 * @param type        Job type string for categorisation in the health panel
 * @param opts        Optional idempotency key
 * @returns           The created job record ID
 */
export async function startWorkflow<T extends JobType>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  workflowFn: (...args: any[]) => Promise<void>,
  args: [string, JobPayloadMap[T]],
  type: T,
  opts: StartWorkflowOptions = {}
): Promise<string> {
  const username = args[0];
  const jobId = opts.idempotencyKey
    ? stableId(type, opts.idempotencyKey)
    : randomUUID();

  console.log(`[start-workflow] ${type} username=${username} jobId=${jobId}`);
  // Record first — if start() throws we still have a trace in the store.
  await createJobRecord(username, type, jobId);
  await start(workflowFn, args);
  console.log(`[start-workflow] ${type} started jobId=${jobId}`);
  return jobId;
}

// Deterministic short ID from type + key (no external crypto needed).
function stableId(type: JobType, key: string): string {
  const raw = `${type}:${key}`;
  return Buffer.from(raw).toString("base64url").slice(0, 32).replace(/[^a-zA-Z0-9]/g, "x");
}
