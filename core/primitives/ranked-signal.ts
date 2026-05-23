/**
 * Primitive 5 — RankedSignal
 *
 * Basil's executive prioritisation moat. Every signal that reaches
 * the surface has a deterministic, explainable score — no opaque AI-only
 * ranking. Every component is independently observable and auditable.
 *
 * Score formula (weights must sum to 1.0):
 *   score = urgency        × 0.30
 *         + hierarchy      × 0.20
 *         + commercialImpact × 0.20
 *         + relationshipWeight × 0.15
 *         + commitmentRisk × 0.10
 *         + meetingProximity × 0.05
 *
 * All component scores are in [0, 1]. Final score is in [0, 1].
 *
 * Critical rules (from engineering guardrails):
 *   - Every ranking must be explainable (explanation[] required)
 *   - Every score component must be observable (all six exposed)
 *   - No opaque AI-only ranking — components derive from signal fields only
 *   - ranking_active flag gates all ranking writes
 */

export interface RankedSignal {
  /** ID of the SignalEvent being ranked. */
  signalId: string;

  /**
   * Final composite score [0, 1]. Higher = surface sooner.
   * Deterministic: same signal + same weights = same score.
   */
  score: number;

  // ── Component scores [0, 1] ───────────────────────────────────────────────

  /**
   * How time-sensitive is this signal?
   * Factors: category (action_required/assigned), trust tier (auto), action due dates.
   */
  urgency: number;

  /**
   * How senior is the counterpart?
   * Factors: CanonicalIdentity.relationshipStrength (if resolved),
   * source weight (proxy when identity unresolved), isDirect on DMs.
   */
  hierarchy: number;

  /**
   * What is the revenue / strategic impact potential?
   * Factors: category (commercial_signal, decision_made, decision_needed).
   */
  commercialImpact: number;

  /**
   * How strong is the relationship with the signal's sender?
   * Factors: CanonicalIdentity.relationshipStrength, directInteractionCount.
   */
  relationshipWeight: number;

  /**
   * What is the risk of missing a commitment?
   * Factors: extracted actions with due dates, action count, overdue detection.
   */
  commitmentRisk: number;

  /**
   * How close is this signal to an upcoming meeting?
   * Factors: eventType=calendar_event, meeting-related category.
   * Note: true proximity scoring requires calendar context (future week).
   */
  meetingProximity: number;

  /**
   * Human-readable explanation for each component that contributed materially.
   * Always populated — empty explanation is a build error.
   * Format: "COMPONENT: reason (value=X)"
   */
  explanation: string[];

  /** ISO8601 — when this ranking was computed. */
  rankedAt: string;

  /**
   * Weights used to compute this score, embedded for auditability.
   * Allows historical comparison if weights change in future.
   */
  weights: {
    urgency: number;
    hierarchy: number;
    commercialImpact: number;
    relationshipWeight: number;
    commitmentRisk: number;
    meetingProximity: number;
  };
}

// ── Canonical weights ─────────────────────────────────────────────────────────

export const RANKING_WEIGHTS = {
  urgency:          0.30,
  hierarchy:        0.20,
  commercialImpact: 0.20,
  relationshipWeight: 0.15,
  commitmentRisk:   0.10,
  meetingProximity: 0.05,
} as const;

// ── Score thresholds ──────────────────────────────────────────────────────────

/**
 * Minimum score to surface in the executive briefing (top priority).
 * Signals above this are shown in the "Needs Your Attention" tier.
 */
export const SURFACE_THRESHOLD = 0.70;

/**
 * Signals above this appear in the standard digest.
 * Below: low-value noise, archived without display.
 */
export const DIGEST_THRESHOLD = 0.35;
