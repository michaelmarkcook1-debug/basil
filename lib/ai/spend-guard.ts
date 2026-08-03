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
import { appendSpendEvent, currentPeriod, secondsUntilPeriodEnd, currentDay, secondsUntilDayEnd } from "./spend-log";

// ── Configuration ──────────────────────────────────────────────────────────────

function numEnv(name: string): number | null {
  const v = process.env[name];
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function globalCapUsd(): number | null { return numEnv("AI_GLOBAL_MONTHLY_USD"); }
function userCapUsd(): number | null { return numEnv("AI_PER_USER_MONTHLY_USD"); }
/**
 * Hard ceiling on spend PER UTC DAY, across all users.
 *
 * A monthly cap cannot express this: $30/month permits burning the whole
 * allowance before lunch and only notices once it is gone. The daily window is
 * what actually bounds the blast radius of a regression — the failure mode this
 * codebase has already produced twice (categorisation on a flagship model,
 * speculative drafts) is "quietly expensive every single day", which a daily
 * ceiling stops within hours instead of weeks.
 */
function dailyCapUsd(): number | null { return numEnv("AI_GLOBAL_DAILY_USD"); }
/**
 * Hard ceiling on spend PER USER PER UTC DAY.
 *
 * Distinct from the global daily cap, and usually the one you want: a global
 * $1/day shared between three accounts is $0.33 each and one busy user starves
 * the rest, whereas per-user $1/day is a real per-account guarantee that scales
 * as accounts are added.
 */
function perUserDailyCapUsd(): number | null { return numEnv("AI_PER_USER_DAILY_USD"); }
function isHardStopped(): boolean { return process.env.AI_SPEND_HARD_STOP === "true"; }

/** Counter TTL — ~70 days so the previous period's counter self-expires. */
const COUNTER_TTL_SECONDS = 70 * 24 * 60 * 60;

// ── Keys ────────────────────────────────────────────────────────────────────────

function globalKey(period: string): string { return `spend:global:${period}`; }
/** Daily ceiling counter. Separate namespace so it can never collide with the
 *  monthly key (a "YYYY-MM-DD" period would otherwise look like a month). */
function dailyKey(day: string): string { return `spend:global:day:${day}`; }
/** Per-user daily counter. Username lower-cased for the same reason userKey
 *  does it — usernames are case-insensitive, so one account must not end up
 *  with two independent daily budgets depending on how it was typed. */
function userDailyKey(username: string, day: string): string {
  return `spend:user:${username.toLowerCase()}:day:${day}`;
}
/** Daily counters only need to outlive their own day; 3 days absorbs clock skew. */
const DAILY_TTL_SECONDS = 3 * 24 * 60 * 60;
// Lowercase the username: usernames are case-insensitive, so per-user spend is
// tracked under one key regardless of how the name was cased at the call site.
function userKey(username: string, period: string): string { return `spend:user:${username.toLowerCase()}:${period}`; }

// ── Types ────────────────────────────────────────────────────────────────────────

export type SpendScope = "user" | "global" | "daily" | "user-daily" | "hard-stop";

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
  /**
   * The UTC day this reservation was taken against, carried explicitly so
   * commit/release adjust the SAME counter even when a long call straddles
   * midnight. Recomputing the day at commit time would credit the refund to
   * tomorrow and leave yesterday permanently over-counted.
   */
  day: string;
  /** USD reserved up front (0 when no cap is configured → observe-only). */
  reservedUsd: number;
}

/**
 * Every counter a reservation touches, with its TTL.
 *
 * Single source of truth so commit and release can never drift apart — a
 * counter incremented on reserve but missed on release would leak budget
 * permanently, and the drift would be invisible until a cap started rejecting
 * for no apparent reason.
 *
 * Always keyed off the reservation's OWN period and day, never the current
 * ones: a call that straddles midnight (or a month boundary) must settle
 * against the window it was reserved in, or that window stays over-counted
 * forever while the next one is under-counted.
 */
function counterKeysFor(r: SpendReservation): [string, number][] {
  return [
    [globalKey(r.period), COUNTER_TTL_SECONDS],
    [userKey(r.username, r.period), COUNTER_TTL_SECONDS],
    [dailyKey(r.day), DAILY_TTL_SECONDS],
    [userDailyKey(r.username, r.day), DAILY_TTL_SECONDS],
  ];
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
  const day = currentDay();
  const gc = globalCapUsd();
  const dc = dailyCapUsd();
  const udc = perUserDailyCapUsd();
  // Per-user cap: the plan entitlement (meter.userMonthlyUsd) takes precedence
  // over the global env default.
  const uc = meter.userMonthlyUsd ?? userCapUsd();

  // No caps → observe-only. Skip reservation; commit still meters usage.
  if (gc === null && uc === null && dc === null && udc === null) {
    return { username: meter.username, feature: meter.feature, family, period, day, reservedUsd: 0 };
  }

  // Reserve for the whole call. Tool-loop paths (chat) run up to maxSteps model
  // calls before onFinish, so we scale the worst case by the step budget — the
  // reservation must bound the ENTIRE in-flight cost, not one step, or many
  // concurrent loops could collectively exceed the cap before commit reconciles.
  const steps = Math.max(1, meter.maxSteps ?? 1);
  const worst = worstCaseCostUsd(kind, family) * steps;

  // Every ceiling this call must satisfy, ordered TIGHTEST FIRST so a rejection
  // touches as few counters as possible.
  //
  // Expressed as a list rather than nested ifs deliberately. With per-user-daily
  // there are four holds, and the previous hand-written rollback needed a branch
  // for every combination of "which earlier holds are already applied" — that
  // grows combinatorially and is exactly where a leaked reservation hides. A
  // leak is silent and permanent: the budget just quietly shrinks. One ordered
  // list and one unwind path removes the whole class.
  const holds: { key: string; ttl: number; cap: number; scope: SpendScope; retryAfter: number }[] = [];
  if (udc !== null) holds.push({ key: userDailyKey(meter.username, day), ttl: DAILY_TTL_SECONDS, cap: udc, scope: "user-daily", retryAfter: secondsUntilDayEnd() });
  if (dc !== null) holds.push({ key: dailyKey(day), ttl: DAILY_TTL_SECONDS, cap: dc, scope: "daily", retryAfter: secondsUntilDayEnd() });
  if (uc !== null) holds.push({ key: userKey(meter.username, period), ttl: COUNTER_TTL_SECONDS, cap: uc, scope: "user", retryAfter: secondsUntilPeriodEnd() });
  if (gc !== null) holds.push({ key: globalKey(period), ttl: COUNTER_TTL_SECONDS, cap: gc, scope: "global", retryAfter: secondsUntilPeriodEnd() });

  const applied: typeof holds = [];
  /** Return every hold taken so far. Best-effort and isolated, so one failed
   *  rollback cannot mask the original error or abort the others. */
  const unwind = async () => {
    for (const h of applied) {
      try { await incrCounter(h.key, -worst, h.ttl); } catch { /* best-effort */ }
    }
    applied.length = 0;
  };

  try {
    for (const h of holds) {
      const { value } = await incrCounter(h.key, worst, h.ttl);
      applied.push(h); // pushed BEFORE the check, so unwind() also returns this one
      if (value > h.cap) {
        await unwind();
        throw new SpendCapError(h.scope, h.retryAfter);
      }
    }
    return { username: meter.username, feature: meter.feature, family, period, day, reservedUsd: worst };
  } catch (err) {
    if (err instanceof SpendCapError) throw err;

    // Counter STORE error (not a cap rejection). Compensate any increment that
    // already committed so a partial reservation never leaks. Each rollback is
    // best-effort and isolated so a rollback failure can't mask the real error.
    await unwind();

    // Fail CLOSED on the expensive Opus family whenever a cap is configured —
    // better to 429 than risk runaway Opus spend during a store outage. (We are
    // past the observe-only early return, so a cap IS configured here.) Cheap
    // families fail OPEN so a transient counter blip can't take down classifiers.
    if (family === "opus") {
      console.error("[spend-guard] counter store error on Opus path — failing CLOSED:", err instanceof Error ? err.message : err);
      throw new SpendCapError("global", secondsUntilPeriodEnd());
    }
    console.warn("[spend-guard] counter store error — failing OPEN (cheap tier):", err instanceof Error ? err.message : err);
    return { username: meter.username, feature: meter.feature, family, period, day, reservedUsd: 0 };
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
    for (const [key, ttl] of counterKeysFor(reservation)) {
      await incrCounter(key, delta, ttl);
    }
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
    for (const [key, ttl] of counterKeysFor(reservation)) {
      await incrCounter(key, -reservation.reservedUsd, ttl);
    }
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
  const dc = dailyCapUsd();
  const udc = perUserDailyCapUsd();
  if (gc === null && uc === null && dc === null && udc === null) return { ok: true };
  const period = currentPeriod();
  const day = currentDay();
  try {
    if (udc !== null) {
      const ud = await getCounter(userDailyKey(username, day));
      if (ud >= udc) return { ok: false, scope: "user-daily", retryAfterSec: secondsUntilDayEnd() };
    }
    if (dc !== null) {
      const d = await getCounter(dailyKey(day));
      if (d >= dc) return { ok: false, scope: "daily", retryAfterSec: secondsUntilDayEnd() };
    }
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
  /** UTC day the daily figures below refer to ("YYYY-MM-DD"). */
  day: string;
  /** Spend so far TODAY, across all users. */
  dailyUsd: number;
  /** Today's ceiling, or null when no daily cap is configured. */
  dailyCapUsd: number | null;
  /** Per-user daily ceiling, or null when not configured. */
  perUserDailyCapUsd: number | null;
  hardStopped: boolean;
  /** `usd` is month-to-date; `todayUsd` is what the per-user daily cap acts on. */
  perUser: { username: string; usd: number; todayUsd: number }[];
}

/** Month-to-date spend summary for the admin panel. */
export async function getSpendSummary(usernames: string[]): Promise<SpendSummary> {
  const period = currentPeriod();
  const globalUsd = await getCounter(globalKey(period)).catch(() => 0);
  const day = currentDay();
  const perUser: { username: string; usd: number; todayUsd: number }[] = [];
  for (const username of usernames) {
    const usd = await getCounter(userKey(username, period)).catch(() => 0);
    // Today's spend for this user — the figure the per-user daily cap acts on,
    // so the summary shows the same number the guard is enforcing against.
    const todayUsd = await getCounter(userDailyKey(username, day)).catch(() => 0);
    if (usd > 0 || todayUsd > 0) perUser.push({ username, usd, todayUsd });
  }
  perUser.sort((a, b) => b.usd - a.usd);
  return {
    period,
    durable: isDurableCounter(),
    globalUsd,
    globalCapUsd: globalCapUsd(),
    userCapUsd: userCapUsd(),
    // Today's spend against today's ceiling — the number that actually answers
    // "is it running away right now", which a month-to-date figure cannot.
    day,
    dailyUsd: await getCounter(dailyKey(day)).catch(() => 0),
    dailyCapUsd: dailyCapUsd(),
    perUserDailyCapUsd: perUserDailyCapUsd(),
    hardStopped: isHardStopped(),
    perUser,
  };
}
