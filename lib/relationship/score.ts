/**
 * Thread health scoring engine.
 *
 * Computes a multi-dimensional ThreadHealth from raw ThreadHealthInput.
 * No LLM, no black box — every score is fully derivable from the inputs.
 *
 * Scoring philosophy:
 *   - Each of 5 dimensions contributes equally (0–20 pts each, total 0–100)
 *   - State is derived from the composite score, not from any one dimension
 *   - A single critical dimension can drag the state down regardless of score
 *   - Alerts are generated independently from scoring — they explain the state
 *   - When data is thin (<3 signals, <7 days old), mark as unreliable
 */

import { createHash } from "node:crypto";
import type {
  HealthAlert,
  HealthDimension,
  HealthSignal,
  HealthState,
  HealthTrend,
  SignalStatus,
  ThreadHealth,
  ThreadHealthInput,
} from "./types";

// ── Thresholds ────────────────────────────────────────────────────────────────

const SILENCE_THRESHOLDS = {
  excellent:  3,   // ≤3 days → healthy
  good:       7,   // ≤7 days → neutral
  warning:   14,   // ≤14 days → warning
  critical:  30,   // ≤30 days → critical; >30 = disengaged signal
} as const;

const COMMITMENT_THRESHOLDS = {
  clean:     0,   // 0 open
  low:       1,   // 1 open
  moderate:  2,   // 2 open
  heavy:     3,   // 3+ open → warning
  stale:    14,   // oldest unresolved age in days → critical
} as const;

const VELOCITY_THRESHOLDS = {
  // signals per week (normalised from 30-day window)
  active:    2.0,   // ≥2/week
  regular:   0.75,  // ≥0.75/week (~3/month)
  sparse:    0.25,  // ≥0.25/week (~1/month)
  dormant:   0,     // <0.25/week
} as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function alertId(...parts: string[]): string {
  return createHash("sha256")
    .update(parts.join(":"))
    .digest("hex")
    .slice(0, 12);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Linear interpolation of score between two points. */
function lerp(value: number, fromLow: number, fromHigh: number, toLow: number, toHigh: number): number {
  if (value <= fromLow) return toHigh;
  if (value >= fromHigh) return toLow;
  const t = (value - fromLow) / (fromHigh - fromLow);
  return toHigh - t * (toHigh - toLow);
}

function plural(n: number, singular: string, pluralForm?: string): string {
  return n === 1 ? `1 ${singular}` : `${n} ${pluralForm ?? singular + "s"}`;
}

// ── Dimension scorers ─────────────────────────────────────────────────────────

function scoreSilence(input: ThreadHealthInput): HealthSignal {
  const d = input.daysSinceLastSignal;

  let score: number;
  let status: SignalStatus;
  let explanation: string | undefined;

  if (d <= SILENCE_THRESHOLDS.excellent) {
    score = 20;
    status = "healthy";
  } else if (d <= SILENCE_THRESHOLDS.good) {
    score = lerp(d, SILENCE_THRESHOLDS.excellent, SILENCE_THRESHOLDS.good, 14, 20);
    status = "neutral";
  } else if (d <= SILENCE_THRESHOLDS.warning) {
    score = lerp(d, SILENCE_THRESHOLDS.good, SILENCE_THRESHOLDS.warning, 8, 14);
    status = "warning";
    explanation = "No contact in over a week — consider following up";
  } else if (d <= SILENCE_THRESHOLDS.critical) {
    score = lerp(d, SILENCE_THRESHOLDS.warning, SILENCE_THRESHOLDS.critical, 2, 8);
    status = "critical";
    explanation = `No contact in ${d} days — relationship may be cooling`;
  } else {
    score = 0;
    status = "critical";
    explanation = `Silent for ${d} days — relationship at risk`;
  }

  const value = d === 0
    ? "Today"
    : d === 1
    ? "Yesterday"
    : `${d} days ago`;

  return {
    dimension: "silence",
    label: "Last contact",
    value,
    score: Math.round(score),
    status,
    explanation,
  };
}

function scoreMomentum(input: ThreadHealthInput): HealthSignal {
  const { signalsLast30Days, signalsPrev30Days, daysSinceLastSignal } = input;

  // Signals per week in the last 30 days
  const velocityCurrent = signalsLast30Days / 4;
  const velocityPrev = signalsPrev30Days / 4;

  let score: number;
  let status: SignalStatus;
  let trend: HealthTrend;
  let explanation: string | undefined;

  if (velocityCurrent >= VELOCITY_THRESHOLDS.active) {
    score = 20;
    status = "healthy";
  } else if (velocityCurrent >= VELOCITY_THRESHOLDS.regular) {
    score = 15;
    status = "neutral";
  } else if (velocityCurrent >= VELOCITY_THRESHOLDS.sparse) {
    score = 9;
    status = "warning";
  } else {
    score = 2;
    status = daysSinceLastSignal > 30 ? "critical" : "warning";
    explanation = "Very low interaction frequency this month";
  }

  // Trend: compare current vs previous 30-day window
  const delta = velocityCurrent - velocityPrev;
  if (delta > 0.3) {
    trend = "improving";
  } else if (delta < -0.3) {
    trend = "declining";
    if (velocityPrev > 0 && velocityCurrent < velocityPrev * 0.5) {
      explanation = `Interaction frequency halved vs last month`;
    }
  } else {
    trend = "stable";
  }

  // Human-readable value
  const perMonth = Math.round(signalsLast30Days);
  const value = perMonth === 0
    ? "None this month"
    : perMonth === 1
    ? "1 this month"
    : `${perMonth}× this month`;

  return {
    dimension: "momentum",
    label: "Interaction rate",
    value,
    score: Math.round(score),
    status,
    trend,
    explanation,
  };
}

function scoreCommitments(input: ThreadHealthInput): HealthSignal {
  const { unresolvedCommitmentCount: count, oldestUnresolvedDays: oldest } = input;

  let score: number;
  let status: SignalStatus;
  let explanation: string | undefined;

  if (count === 0) {
    score = 20;
    status = "healthy";
  } else if (count === 1) {
    score = 16;
    status = "neutral";
    if (oldest !== null && oldest >= COMMITMENT_THRESHOLDS.stale) {
      score = 8;
      status = "warning";
      explanation = `1 commitment is ${oldest} days old`;
    }
  } else if (count === 2) {
    score = 10;
    status = "warning";
    if (oldest !== null && oldest >= COMMITMENT_THRESHOLDS.stale) {
      score = 4;
      status = "critical";
      explanation = `Oldest commitment is ${oldest} days overdue`;
    }
  } else {
    score = 2;
    status = "critical";
    explanation = `${count} unresolved commitments — oldest ${oldest ?? "?"}d`;
  }

  const value = count === 0
    ? "None open"
    : oldest !== null
    ? `${plural(count, "open")} · oldest ${oldest}d`
    : plural(count, "open");

  return {
    dimension: "commitments",
    label: "Commitments",
    value,
    score: Math.round(score),
    status,
    explanation,
  };
}

function scoreVitality(input: ThreadHealthInput): HealthSignal {
  const { threadStatus, sourceCount, signalsLast30Days } = input;

  let score: number;
  let status: SignalStatus;
  let explanation: string | undefined;

  if (threadStatus === "closed") {
    score = 0;
    status = "critical";
    explanation = "Thread is closed";
  } else if (threadStatus === "stale") {
    score = 6;
    status = "warning";
    explanation = "Thread has gone stale — no new signals in 7+ days";
  } else {
    // open
    score = signalsLast30Days > 0 ? 18 : 12;
    status = signalsLast30Days > 3 ? "healthy" : "neutral";
  }

  // Bonus for multi-source engagement (richer relationship)
  if (sourceCount > 1 && score > 0) {
    score = Math.min(20, score + 2);
  }

  const value = threadStatus === "open"
    ? sourceCount > 1 ? `Active · ${sourceCount} channels` : "Active"
    : threadStatus === "stale"
    ? "Going stale"
    : "Closed";

  return {
    dimension: "vitality",
    label: "Thread status",
    value,
    score: Math.round(score),
    status,
    explanation,
  };
}

function scoreDepth(input: ThreadHealthInput): HealthSignal {
  const { totalSignalCount, relationshipAgeDays } = input;

  if (relationshipAgeDays < 1) {
    return {
      dimension: "depth",
      label: "Engagement depth",
      value: "New thread",
      score: 10,
      status: "neutral",
    };
  }

  // Signals per month normalised against relationship age
  const signalsPerMonth = (totalSignalCount / Math.max(1, relationshipAgeDays)) * 30;

  let score: number;
  let status: SignalStatus;

  if (signalsPerMonth >= 8) {
    score = 20;
    status = "healthy";
  } else if (signalsPerMonth >= 4) {
    score = 15;
    status = "neutral";
  } else if (signalsPerMonth >= 2) {
    score = 10;
    status = "neutral";
  } else if (signalsPerMonth >= 0.5) {
    score = 6;
    status = "warning";
  } else {
    score = 2;
    status = "critical";
  }

  const ageDays = Math.round(relationshipAgeDays);
  const value = ageDays < 7
    ? `${totalSignalCount} signals · ${ageDays}d old`
    : `${totalSignalCount} signals · ${Math.round(ageDays / 7)}wk span`;

  return {
    dimension: "depth",
    label: "Engagement depth",
    value,
    score: Math.round(score),
    status,
  };
}

// ── State derivation ──────────────────────────────────────────────────────────

function deriveState(score: number, signals: HealthSignal[]): HealthState {
  // Hard overrides — a single critical dimension can force a lower state
  const criticalCount = signals.filter((s) => s.status === "critical").length;
  const warningCount = signals.filter((s) => s.status === "warning").length;

  // Disengaged: score below 20 OR silence critical + vitality critical
  const silenceSignal = signals.find((s) => s.dimension === "silence");
  const vitalitySignal = signals.find((s) => s.dimension === "vitality");

  if (
    score < 20 ||
    (silenceSignal?.status === "critical" && vitalitySignal?.status === "critical")
  ) {
    return "disengaged";
  }

  if (score < 35 || criticalCount >= 2) return "critical";
  if (score < 55 || (criticalCount >= 1 && warningCount >= 1)) return "cooling";
  if (score < 75) return "stable";
  return "strengthening";
}

function deriveTrend(signals: HealthSignal[], input: ThreadHealthInput): HealthTrend {
  const momentumSignal = signals.find((s) => s.dimension === "momentum");

  // Explicit momentum trend
  if (momentumSignal?.trend === "declining") return "declining";
  if (momentumSignal?.trend === "improving") return "improving";

  // Infer from silence — recent activity suggests improvement
  if (input.daysSinceLastSignal <= 2 && input.signalsLast30Days >= 4) return "improving";
  if (input.daysSinceLastSignal > SILENCE_THRESHOLDS.warning) return "declining";

  return "stable";
}

// ── Alert generation ──────────────────────────────────────────────────────────

function buildAlerts(
  input: ThreadHealthInput,
  signals: HealthSignal[],
  state: HealthState
): HealthAlert[] {
  const alerts: HealthAlert[] = [];

  const { daysSinceLastSignal: silence, unresolvedCommitmentCount, oldestUnresolvedDays, threadStatus } = input;

  // Silence alert
  if (silence >= SILENCE_THRESHOLDS.warning && state !== "disengaged") {
    alerts.push({
      id: alertId("silence", String(Math.floor(silence / 7))),
      severity: silence >= SILENCE_THRESHOLDS.critical ? "critical" : "warning",
      message: `No contact in ${silence} days — a follow-up may be warranted`,
      actionLabel: "Draft follow-up",
      actionHref: "/dashboard/chat",
    });
  }

  if (silence > SILENCE_THRESHOLDS.critical) {
    alerts.push({
      id: alertId("silence-critical", String(Math.floor(silence / 14))),
      severity: "critical",
      message: `Thread silent for ${silence} days — relationship may be disengaging`,
    });
  }

  // Commitment alerts
  if (unresolvedCommitmentCount > 0 && oldestUnresolvedDays !== null && oldestUnresolvedDays >= COMMITMENT_THRESHOLDS.stale) {
    alerts.push({
      id: alertId("commitment-stale", String(Math.floor(oldestUnresolvedDays / 7))),
      severity: oldestUnresolvedDays >= 21 ? "critical" : "warning",
      message: `Oldest commitment is ${oldestUnresolvedDays} days unresolved — blocks relationship progress`,
      actionLabel: "View actions",
      actionHref: "/dashboard/actions",
    });
  }

  if (unresolvedCommitmentCount >= 3) {
    alerts.push({
      id: alertId("commitment-count", String(unresolvedCommitmentCount)),
      severity: "warning",
      message: `${plural(unresolvedCommitmentCount, "unresolved commitment")} — high obligation load`,
    });
  }

  // Stale thread alert
  if (threadStatus === "stale") {
    alerts.push({
      id: alertId("stale-thread"),
      severity: "warning",
      message: "Thread is going stale — activity has dropped off",
    });
  }

  // Momentum decline
  const momentumSignal = signals.find((s) => s.dimension === "momentum");
  if (momentumSignal?.trend === "declining" && momentumSignal.status !== "healthy") {
    alerts.push({
      id: alertId("momentum-decline"),
      severity: "info",
      message: "Interaction frequency has declined compared to last month",
    });
  }

  // Deduplicate by id (in case multiple conditions produce same id)
  const seen = new Set<string>();
  return alerts.filter((a) => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
}

// ── Main scorer ───────────────────────────────────────────────────────────────

/**
 * Compute ThreadHealth from raw inputs.
 *
 * All scoring is deterministic and explainable.
 * Every HealthSignal includes a human-readable explanation of its score.
 */
export function computeThreadHealth(input: ThreadHealthInput): ThreadHealth {
  const now = new Date().toISOString();

  // Reliability check — insufficient data
  const reliable =
    input.totalSignalCount >= 2 &&
    input.relationshipAgeDays >= 2;

  if (!reliable) {
    return {
      state: "unknown",
      score: 50,
      trend: "stable",
      signals: [],
      alerts: [],
      computedAt: now,
      reliable: false,
    };
  }

  // Score all five dimensions
  const signals = [
    scoreSilence(input),
    scoreMomentum(input),
    scoreCommitments(input),
    scoreVitality(input),
    scoreDepth(input),
  ];

  // Composite score: sum of all dimension scores (each 0–20)
  const score = clamp(signals.reduce((sum, s) => sum + s.score, 0), 0, 100);

  const state = deriveState(score, signals);
  const trend = deriveTrend(signals, input);
  const alerts = buildAlerts(input, signals, state);

  return {
    state,
    score,
    trend,
    signals,
    alerts,
    computedAt: now,
    reliable: true,
  };
}

/**
 * Derive ThreadHealthInput from SignalThread fields + action count.
 * Approximates 30-day windows from available timestamp data.
 */
export function inputFromThread(thread: {
  firstSignalAt: string;
  lastSignalAt: string;
  signalCount: number;
  status: "open" | "stale" | "closed";
  sources: string[];
  actionIds: string[];
  unresolvedCommitmentCount?: number;
  oldestUnresolvedDays?: number | null;
}): ThreadHealthInput {
  const now = Date.now();
  const daysSinceLastSignal = Math.floor(
    (now - new Date(thread.lastSignalAt).getTime()) / 86_400_000
  );
  const relationshipAgeDays = Math.max(1, Math.floor(
    (now - new Date(thread.firstSignalAt).getTime()) / 86_400_000
  ));

  // Estimate 30-day windows from total count + recency
  // If thread is older than 30d, signals in last 30 days is approximated
  // from silence: active threads have at least 1 signal if daysSinceLastSignal < 30
  const estimatedSignalsLast30 = daysSinceLastSignal < 30
    ? Math.max(1, Math.round(thread.signalCount * Math.min(1, 30 / relationshipAgeDays)))
    : 0;
  const estimatedSignalsPrev30 = Math.max(0, thread.signalCount - estimatedSignalsLast30);

  return {
    daysSinceLastSignal,
    relationshipAgeDays,
    totalSignalCount: thread.signalCount,
    signalsLast30Days: estimatedSignalsLast30,
    signalsPrev30Days: estimatedSignalsPrev30,
    unresolvedCommitmentCount: thread.unresolvedCommitmentCount ?? thread.actionIds.length,
    oldestUnresolvedDays: thread.oldestUnresolvedDays ?? null,
    threadStatus: thread.status,
    sourceCount: thread.sources.length,
  };
}
