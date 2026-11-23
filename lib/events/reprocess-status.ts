/**
 * lib/events/reprocess-status.ts — progress of "Re-process recent events".
 *
 * The backfill runs in the background after the button's request returns, so
 * until 2026-11-23 the only sign it was working was the server log. It now
 * writes its progress here as it goes; Settings reads it back and shows
 * "Analysing 120 of 352…" and, at the end, what it found.
 */
import "server-only";
import { readUserStore, updateUserStore } from "@/lib/storage/user-store";

export interface ReprocessStatus {
  startedAt: string;
  updatedAt: string;
  /** "34 email, 9 Zoom, 309 Slack" */
  breakdown: string;
  total: number;
  /** Items looked at so far. */
  checked: number;
  /** Of those, skipped without an AI call because nothing had changed since last time. */
  unchanged: number;
  failed: number;
  finishedAt?: string;
  /** New actions and decisions it created (counted at the end). */
  newActions?: number;
  newDecisions?: number;
  /** Stopped at its time limit before the end; pressing again carries on. */
  stoppedEarly?: boolean;
  /** "cron" or "button". */
  by: "cron" | "button";
}

const FILE = "reprocess-status.json";

export async function readReprocessStatus(username: string): Promise<ReprocessStatus | null> {
  return readUserStore<ReprocessStatus | null>(username, FILE, null, { fresh: true });
}

export async function writeReprocessStatus(username: string, patch: Partial<ReprocessStatus>): Promise<void> {
  await updateUserStore<ReprocessStatus | null>(username, FILE, (cur) => ({
    ...(cur ?? { startedAt: new Date().toISOString(), breakdown: "", total: 0, checked: 0, unchanged: 0, failed: 0, by: "button" as const }),
    ...patch,
    updatedAt: new Date().toISOString(),
  }), null, { allowShrink: true });
}
