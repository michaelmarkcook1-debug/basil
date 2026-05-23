/**
 * Parity Validator — Week 2 Cutover Gate
 *
 * Reads the shadow log and enforces the parity thresholds that must be
 * satisfied before any source cutover is allowed.
 *
 * Gate thresholds (non-negotiable per the Tier-0 protection plan):
 *   exactMatchRate  ≥ 0.90   (90% of signals matched exactly)
 *   criticalDiffRate < 0.02  (fewer than 2% had critical diffs)
 *   minShadowDays   ≥ 14     (at least 14 days of shadow data)
 *   minSampleSize   ≥ 50     (at least 50 comparisons to be statistically valid)
 *
 * Used by:
 *   - GET /api/admin/parity-status  (human review)
 *   - setFlag("sources.gmail_cutover") guard (future Week 3)
 *
 * Design: read-only — never writes, never affects pipeline.
 */

import { readUserStore } from "@/lib/storage/user-store";
import type { ShadowComparison } from "./shadow-runner";
import { computeParityMetrics } from "./shadow-runner";

const SHADOW_LOG_FILE = "sage-shadow-log.json";

// ── Gate thresholds ───────────────────────────────────────────────────────────

export const PARITY_GATES = {
  /** Minimum fraction of signals that must match exactly (no critical/warning diffs). */
  exactMatchRate: 0.90,
  /** Maximum fraction of signals with critical diffs. */
  criticalDiffRate: 0.02,
  /** Minimum days of shadow history before cutover is permitted. */
  minShadowDays: 14,
  /** Minimum number of comparisons for statistical validity. */
  minSampleSize: 50,
} as const;

// ── Report types ──────────────────────────────────────────────────────────────

export interface GateResult {
  /** Name of this gate. */
  gate: string;
  /** Whether the gate is satisfied. */
  passed: boolean;
  /** Observed value (number or string). */
  observed: number | string;
  /** Required threshold. */
  required: number | string;
  /** Human-readable explanation. */
  explanation: string;
}

export interface ParityReport {
  /** ISO8601 timestamp of when this report was generated. */
  generatedAt: string;
  /** Overall go/no-go decision. true only if ALL gates pass. */
  cutoversAllowed: boolean;
  /** Individual gate results. */
  gates: GateResult[];
  /** Raw metrics from computeParityMetrics(). */
  metrics: {
    total: number;
    matches: number;
    exactMatchRate: number;
    criticalDiffs: number;
    criticalDiffRate: number;
    normalizerErrors: number;
  };
  /** ISO8601 of the oldest shadow comparison — used to compute shadow age. */
  oldestComparisonAt: string | null;
  /** ISO8601 of the newest shadow comparison. */
  newestComparisonAt: string | null;
  /** Elapsed shadow days. */
  shadowDays: number;
  /**
   * If cutover is not yet allowed, a short human-readable reason.
   * null when cutoversAllowed is true.
   */
  blockedReason: string | null;
}

// ── Validator ─────────────────────────────────────────────────────────────────

/**
 * Compute the full parity report for a user.
 * Reads directly from the shadow log (no cache) — this is an audit-path call.
 */
export async function validateParityGates(username: string): Promise<ParityReport> {
  const generatedAt = new Date().toISOString();
  const comparisons = await readUserStore<ShadowComparison[]>(
    username,
    SHADOW_LOG_FILE,
    []
  );

  const metrics = computeParityMetrics(comparisons);

  // ── Compute shadow age ─────────────────────────────────────────────────────
  let oldestComparisonAt: string | null = null;
  let newestComparisonAt: string | null = null;
  let shadowDays = 0;

  if (comparisons.length > 0) {
    const sorted = [...comparisons].sort((a, b) =>
      a.comparedAt.localeCompare(b.comparedAt)
    );
    oldestComparisonAt = sorted[0].comparedAt;
    newestComparisonAt = sorted[sorted.length - 1].comparedAt;
    shadowDays =
      (new Date(newestComparisonAt).getTime() -
        new Date(oldestComparisonAt).getTime()) /
      86_400_000;
  }

  // ── Evaluate gates ─────────────────────────────────────────────────────────
  const gates: GateResult[] = [];

  // Gate 1: Sample size
  const samplePassed = metrics.total >= PARITY_GATES.minSampleSize;
  gates.push({
    gate: "minSampleSize",
    passed: samplePassed,
    observed: metrics.total,
    required: PARITY_GATES.minSampleSize,
    explanation: samplePassed
      ? `${metrics.total} comparisons collected — sufficient sample.`
      : `Only ${metrics.total} comparisons; need at least ${PARITY_GATES.minSampleSize} before gates are meaningful.`,
  });

  // Gate 2: Shadow duration
  const shadowPassed = shadowDays >= PARITY_GATES.minShadowDays;
  gates.push({
    gate: "minShadowDays",
    passed: shadowPassed,
    observed: Math.round(shadowDays * 10) / 10,
    required: PARITY_GATES.minShadowDays,
    explanation: shadowPassed
      ? `${Math.floor(shadowDays)} days of shadow data collected.`
      : `Only ${Math.floor(shadowDays)} days of shadow data; need ${PARITY_GATES.minShadowDays} before cutover.`,
  });

  // Gate 3: Exact match rate
  const matchPassed =
    metrics.total > 0 &&
    metrics.exactMatchRate >= PARITY_GATES.exactMatchRate;
  gates.push({
    gate: "exactMatchRate",
    passed: matchPassed,
    observed: Math.round(metrics.exactMatchRate * 1000) / 10,   // percentage, 1dp
    required: Math.round(PARITY_GATES.exactMatchRate * 100),
    explanation: matchPassed
      ? `${Math.round(metrics.exactMatchRate * 100)}% of signals matched — above 90% threshold.`
      : `Match rate ${Math.round(metrics.exactMatchRate * 100)}% is below the required 90%.`,
  });

  // Gate 4: Critical diff rate
  const critPassed =
    metrics.total === 0 ||
    metrics.criticalDiffRate < PARITY_GATES.criticalDiffRate;
  gates.push({
    gate: "criticalDiffRate",
    passed: critPassed,
    observed: Math.round(metrics.criticalDiffRate * 1000) / 10,  // percentage, 1dp
    required: `< ${Math.round(PARITY_GATES.criticalDiffRate * 100)}`,
    explanation: critPassed
      ? `Critical diff rate ${Math.round(metrics.criticalDiffRate * 100 * 10) / 10}% is below the 2% ceiling.`
      : `Critical diff rate ${Math.round(metrics.criticalDiffRate * 100 * 10) / 10}% exceeds the 2% ceiling — data integrity risk.`,
  });

  const cutoversAllowed = gates.every((g) => g.passed);

  // Synthesise a single human-readable blocked reason
  let blockedReason: string | null = null;
  if (!cutoversAllowed) {
    const failing = gates.filter((g) => !g.passed);
    blockedReason = failing.map((g) => g.explanation).join(" ");
  }

  return {
    generatedAt,
    cutoversAllowed,
    gates,
    metrics,
    oldestComparisonAt,
    newestComparisonAt,
    shadowDays,
    blockedReason,
  };
}
