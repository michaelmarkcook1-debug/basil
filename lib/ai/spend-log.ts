/**
 * lib/ai/spend-log.ts — append-only AI spend event log + period helpers.
 *
 * Every metered LLM call appends ONE immutable event blob at:
 *   basil/spend/<YYYY-MM>/events/<ts>-<rand>.json
 *
 * This log is the RECOVERABLE SOURCE OF TRUTH for spend: even if the durable
 * counters (lib/storage/counter.ts) drift — e.g. on the non-atomic Blob
 * fallback — a reconciliation sweep can recompute exact per-user and global
 * totals by summing the event log for a period. The counters exist only to make
 * the pre-call budget check O(1); the log is what's authoritative.
 *
 * Filenames embed a timestamp + random suffix so concurrent appends never
 * collide (the persistent store is otherwise last-write-wins on a fixed path).
 *
 * server-only.
 */

import "server-only";
import { randomUUID } from "node:crypto";
import { writeStore } from "@/lib/storage/persistent";
import type { PriceFamily } from "./pricing";

export interface SpendEvent {
  /** epoch ms */
  ts: number;
  username: string;
  /** call-site label, e.g. "chat", "briefing", "draft", "classify:slack" */
  feature: string;
  family: PriceFamily;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

/** Current billing period as "YYYY-MM" (UTC). */
export function currentPeriod(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Seconds remaining until the end of the current UTC month (for Retry-After). */
export function secondsUntilPeriodEnd(): number {
  const d = new Date();
  const nextMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0);
  return Math.max(60, Math.ceil((nextMonth - d.getTime()) / 1000));
}

/**
 * Current DAY as "YYYY-MM-DD" (UTC).
 *
 * A monthly cap alone cannot express "spend no more than $1/day" — a runaway
 * can burn the entire month's allowance in one morning and the ceiling only
 * notices once it is already gone. The daily window is what actually bounds
 * blast radius, so it gets its own counter.
 */
export function currentDay(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Seconds remaining until 00:00 UTC (for Retry-After on a daily rejection). */
export function secondsUntilDayEnd(): number {
  const d = new Date();
  const tomorrow = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0);
  return Math.max(60, Math.ceil((tomorrow - d.getTime()) / 1000));
}

/**
 * Append a spend event. Best-effort and non-throwing — a logging failure must
 * never break the AI call that already happened.
 */
export async function appendSpendEvent(event: SpendEvent): Promise<void> {
  try {
    const filename = `${event.ts}-${randomUUID().slice(0, 8)}.json`;
    // Strong durability: this log is the recoverable source of truth for AI
    // spend, so it must land durably before the call returns — an eventual
    // write can be lost when the function instance recycles.
    await writeStore(filename, event, `spend/${currentPeriod()}/events`, {
      durability: "strong",
    });
  } catch (err) {
    console.error("[spend-log] appendSpendEvent failed (non-fatal):", err instanceof Error ? err.message : err);
  }
}
