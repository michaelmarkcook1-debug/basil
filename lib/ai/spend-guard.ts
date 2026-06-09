/**
 * lib/ai/spend-guard.ts — per-user + global AI spend cap with reserve/commit.
 *
 * Protects against unbounded AI bills. Every metered LLM call goes through:
 *
 *   1. reserveSpend()  — BEFORE the call. Atomically adds the worst-case cost
 *      (tier max-output tokens) to the per-user and global month counters and
 *      throws SpendCapError (HTTP 429) if either cap would be exceeded. This
 *      reservation is what prevents many concurrent in-flight Opus streams from
 *      collectively blowing past the ceiling — they each reserve up front.
 *
 *   2. commitSpend()   — AFTER the call. Reconciles the counters from the
 *      worst-case reservation down to ACTUAL token usage (delta = actual −
 *      reserved, usually negative) and appends the authoritative spend event.
 *
 *   3. releaseSpend()  — on call FAILURE. Returns the full reservation so a
 *      failed call costs nothing.
 *
 * Configuration (all optional — unset means "observe only, never block"):
 *   AI_GLOBAL_MONTHLY_USD   hard global ceiling, USD/month
 *   AI_PER_USER_MONTHLY_USD hard per-user ceiling, USD/month
 *   AI_SPEND_HARD_STOP=true kill switch — blocks ALL AI immediately
 *
 * Store-failure policy: when a cap IS configured but the counter store errors,
 * we FAIL CLOSED on the expensive Opus family (better to 429 than risk runaway
 * Opus spend) and FAIL OPEN on cheap families (Haiku/Sonnet classifiers must
 * not be taken down by a transient counter blip).
 *
 * When NO cap is configured the guard still records usage to the counters and
 * event log so spend is observable from day one (the admin endpoint reads it).
 *
 * server-only.
 */

import "server-only";
import type { ModelKind } from "./model-config";
import {
  type PriceFamily,
  familyForTier,
  worstCaseCostUsd,
  costUsd,
  type TokenUsage,
} from "./pricing";
import { incrCounter, getCounter, isDurableCounter } from "@/lib/storage/counter";
import { appendSpendEvent, currentPeriod, secondsUntilPeriodEnd } from "./spend-log";

// ── Configuration ──────────────────────────────────────────────────────────────

function numEnv(name: string): number | null {
  const v = process.env[name];
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function globalCapUsd(): number | null { return numEnv("AI_GLOBAL_MONTHLY_USD"); }
function userCapUsd(): number | null { return numEnv("AI_PER_USER_MONTHLY_USD"); }
function isHardStopped(): boolean { return process.env.AI_SPEND_HARD_STOP === "true"; }

/** Counter TTL — ~70 days so the previous period's counter self-expires. */
const COUNTER_TTL_SECONDS = 70 * 24 * 60 * 60;

// ── Keys ────────────────────────────────────────────────────────────────────────

function globalKey(period: string): string { return `spend:global:${period}`; }
function userKey(username: string, period: string): string { return `spend:user:${username}:${period}`; }

// ── Types ────────────────────────────────────────────────────────────────────────

export type SpendScope = "user" | "global" | "hard-stop";

export class SpendCapError extends Error {
  readonly status = 429;
  constructor(public readonly scope: SpendScope, public readonly retryAfterSec: number = 3600) {
    super(`AI spend cap reached (${scope})`);
    this.name = "SpendCapError";
  }
}

export interface SpendMeter {
  username: string;
  /** call-site label for the event log, e.g. "chat" | "briefing" | "draft" */
  feature: string;
  /** Override the family for plan-aware down-tiering (#4). Defaults to tier→family. */
  family?: PriceFamily;
  /**
   * Per-user monthly USD cap for THIS user, from their plan entitlement
   * (lib/billing). When set, it overrides the global AI_PER_USER_MONTHLY_USD env
   * cap — so "your plan's AI quota" and "your spend cap" are one number.
   */
  userMonthlyUsd?: number;
  /**
   * Max model calls this request may make (tool-loop step budget, e.g.
   * stepCountIs(8)). The reservation scales worst-case cost by this so the
   * whole in-flight call is bounded, not just the first step. Defaults to 1.
   */
  maxSteps?: number;
}

export interface SpendReservation {
  username: string;
  feature: string;
  family: PriceFamily;
  period: string;
  /** USD reserved up front (0 when no cap is configured → observe-only). */
  reservedUsd: number;
}

// ── Reserve ──────────────────────────────────────────────────────────────────────

/**
 * Reserve worst-case budget before an LLM call. Throws SpendCapError if the
 * per-user or global cap would be exceeded. Returns a reservation to pass to
 * commitSpend()/releaseSpend(), or a zero reservation when no cap is configured
 * (so commit still records usage for observability).
 */
export async function reserveSpend(meter: SpendMeter, kind: ModelKind): Promise<SpendReservation> {
  if (isHardStopped()) throw new SpendCapError("hard-stop", secondsUntilPeriodEnd());

  const family = meter.family ?? familyForTier(kind);
  const period = currentPeriod();
  const gc = globalCapUsd();
  // Per-user cap: the plan entitlement (meter.userMonthlyUsd) takes precedence
  // over the global env default.
  const uc = meter.userMonthlyUsd ?? userCapUsd();

  // No caps → observe-only. Skip reservation; commit still meters usage.
  if (gc === null && uc === null) {
    return { username: meter.username, feature: meter.feature, family, period, reservedUsd: 0 };
  }

  // Reserve for the whole call. Tool-loop paths (chat) run up to maxSteps model
  // calls before onFinish, so we scale the worst case by the step budget — the
  // reservation must bound the ENTIRE in-flight cost, not one step, or many
  // concurrent loops could collectively exceed the cap before commit reconciles.
  const steps = Math.max(1, meter.maxSteps ?? 1);
  const worst = worstCaseCostUsd(kind, family) * steps;

  // Track which counters we actually incremented so the catch can compensate
  // any committed increment (finding: a user-step store error after a successful
  // global increment must not leak the global reservation forever).
  let globalApplied = false;
  let userApplied = false;

  try {
    if (gc !== null) {
      const { value } = await incrCounter(globalKey(period), worst, COUNTER_TTL_SECONDS);
      globalApplied = true;
      if (value > gc) {
        await incrCounter(globalKey(period), -worst, COUNTER_TTL_SECONDS); // roll back
        globalApplied = false;
        throw new SpendCapError("global", secondsUntilPeriodEnd());
      }
    }
    if (uc !== null) {
      const { value } = await incrCounter(userKey(meter.username, period), worst, COUNTER_TTL_SECONDS);
      userApplied = true;
      if (value > uc) {
        await incrCounter(userKey(meter.username, period), -worst, COUNTER_TTL_SECONDS); // roll back user
        userApplied = false;
        if (globalApplied) {
          await incrCounter(globalKey(period), -worst, COUNTER_TTL_SECONDS); // and global
          globalApplied = false;
        }
        throw new SpendCapError("user", secondsUntilPeriodEnd());
      }
    }
    return { username: meter.username, feature: meter.feature, family, period, reservedUsd: worst };
  } catch (err) {
    if (err instanceof SpendCapError) throw err;

    // Counter STORE error (not a cap rejection). Compensate any increment that
    // already committed so a partial reservation never leaks. Each rollback is
    // best-effort and isolated so a rollback failure can't mask the real error.
    if (globalApplied) {
      try { await incrCounter(globalKey(period), -worst, COUNTER_TTL_SECONDS); } catch { /* best-effort */ }
    }
    if (userApplied) {
      try { await incrCounter(userKey(meter.username, period), -worst, COUNTER_TTL_SECONDS); } catch { /* best-effort */ }
    }

    // Fail CLOSED on the expensive Opus family whenever a cap is configured —
    // better to 429 than risk runaway Opus spend during a store outage. (We are
    // past the observe-only early return, so a cap IS configured here.) Cheap
    // families fail OPEN so a transient counter blip can't take down classifiers.
    if (family === "opus") {
      console.error("[spend-guard] counter store error on Opus path — failing CLOSED:", err instanceof Error ? err.message : err);
      throw new SpendCapError("global", secondsUntilPeriodEnd());
    }
    console.warn("[spend-guard] counter store error — failing OPEN (cheap tier):", err instanceof Error ? err.message : err);
    return { username: meter.username, feature: meter.feature, family, period, reservedUsd: 0 };
  }
}

// ── Commit ───────────────────────────────────────────────────────────────────────

/**
 * Reconcile counters to actual usage and append the authoritative spend event.
 * Always increments the counters by (actual − reserved) so month-to-date spend
 * is observable even when no cap is configured. Never throws.
 */
export async function commitSpend(
  reservation: SpendReservation,
  usage: TokenUsage | undefined,
  familyOverride?: PriceFamily
): Promise<void> {
  const family = familyOverride ?? reservation.family;
  const actualUsd = costUsd(family, usage);
  const delta = actualUsd - reservation.reservedUsd;

  try {
    await incrCounter(globalKey(reservation.period), delta, COUNTER_TTL_SECONDS);
    await incrCounter(userKey(reservation.username, reservation.period), delta, COUNTER_TTL_SECONDS);
  } catch (err) {
    console.error("[spend-guard] commit counter update failed (event log still recorded):", err instanceof Error ? err.message : err);
  }

  await appendSpendEvent({
    ts: Date.now(),
    username: reservation.username,
    feature: reservation.feature,
    family,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    usd: actualUsd,
  });
}

/** Return a reservation in full when the call failed (so it costs nothing). */
export async function releaseSpend(reservation: SpendReservation): Promise<void> {
  if (reservation.reservedUsd <= 0) return;
  try {
    await incrCounter(globalKey(reservation.period), -reservation.reservedUsd, COUNTER_TTL_SECONDS);
    await incrCounter(userKey(reservation.username, reservation.period), -reservation.reservedUsd, COUNTER_TTL_SECONDS);
  } catch (err) {
    console.error("[spend-guard] releaseSpend failed:", err instanceof Error ? err.message : err);
  }
}

// ── Read-only checks (for routes that want a fast 429 before expensive prep) ─────

export interface SpendStatus {
  ok: boolean;
  scope?: SpendScope;
  retryAfterSec?: number;
}

export async function checkSpendBudget(username: string): Promise<SpendStatus> {
  if (isHardStopped()) return { ok: false, scope: "hard-stop", retryAfterSec: secondsUntilPeriodEnd() };
  const gc = globalCapUsd();
  const uc = userCapUsd();
  if (gc === null && uc === null) return { ok: true };
  const period = currentPeriod();
  try {
    if (gc !== null) {
      const g = await getCounter(globalKey(period));
      if (g >= gc) return { ok: false, scope: "global", retryAfterSec: secondsUntilPeriodEnd() };
    }
    if (uc !== null) {
      const u = await getCounter(userKey(username, period));
      if (u >= uc) return { ok: false, scope: "user", retryAfterSec: secondsUntilPeriodEnd() };
    }
  } catch (err) {
    console.warn("[spend-guard] checkSpendBudget store error — allowing:", err instanceof Error ? err.message : err);
  }
  return { ok: true };
}

/**
 * Global-only budget check — used by unattended cron fan-outs (briefing,
 * ingest) to short-circuit BEFORE looping every user, so an approaching global
 * ceiling pauses the background spend that scales linearly with user count.
 */
export async function checkGlobalBudget(): Promise<SpendStatus> {
  if (isHardStopped()) return { ok: false, scope: "hard-stop", retryAfterSec: secondsUntilPeriodEnd() };
  const gc = globalCapUsd();
  if (gc === null) return { ok: true };
  try {
    const g = await getCounter(globalKey(currentPeriod()));
    if (g >= gc) return { ok: false, scope: "global", retryAfterSec: secondsUntilPeriodEnd() };
  } catch (err) {
    console.warn("[spend-guard] checkGlobalBudget store error — allowing:", err instanceof Error ? err.message : err);
  }
  return { ok: true };
}

// ── Admin reporting ──────────────────────────────────────────────────────────────

export interface SpendSummary {
  period: string;
  durable: boolean;
  globalUsd: number;
  globalCapUsd: number | null;
  userCapUsd: number | null;
  hardStopped: boolean;
  perUser: { username: string; usd: number }[];
}

/** Month-to-date spend summary for the admin panel. */
export async function getSpendSummary(usernames: string[]): Promise<SpendSummary> {
  const period = currentPeriod();
  const globalUsd = await getCounter(globalKey(period)).catch(() => 0);
  const perUser: { username: string; usd: number }[] = [];
  for (const username of usernames) {
    const usd = await getCounter(userKey(username, period)).catch(() => 0);
    if (usd > 0) perUser.push({ username, usd });
  }
  perUser.sort((a, b) => b.usd - a.usd);
  return {
    period,
    durable: isDurableCounter(),
    globalUsd,
    globalCapUsd: globalCapUsd(),
    userCapUsd: userCapUsd(),
    hardStopped: isHardStopped(),
    perUser,
  };
}
