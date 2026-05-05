/**
 * Basil Trust Framework — confidence, provenance, and approval policy.
 *
 * Every proactive output (extracted actions, decisions, memories) is governed
 * by this policy. It defines the confidence tiers, per-domain thresholds, and
 * the rules that determine whether an item auto-materializes or is held for
 * user review.
 *
 * ## Tiers
 *
 * AUTO   (≥ AUTO threshold)  — materialize immediately, no user gate.
 * REVIEW (≥ SKIP floor)      — materialize with needsReview=true; user can
 *                               confirm (clears the flag) or dismiss (deletes).
 * SKIP   (< SKIP floor)      — discard entirely; too noisy to surface.
 *
 * ## Principle
 * Be honest, not noisy. A smaller set of verified items is more useful than a
 * large set of uncertain ones. Low-confidence extractions that were previously
 * silently dropped are now surfaced as "pending review" so Michael has
 * visibility and control.
 *
 * ## What auto-materializes vs what requires review
 *
 * | Item            | Skip if conf < | Review if conf < | Auto if conf ≥ |
 * |-----------------|---------------|-----------------|----------------|
 * | Action item     | 0.35          | 0.60            | 0.60           |
 * | Decision record | 0.45          | 0.70            | 0.70           |
 * | Memory (infer.) | 0.40          | 0.60            | 0.60           |
 * | Zoom-sourced *  | 0.30          | 0.60            | 0.60           |
 * | Outbound reply  | —             | always draft    | never auto     |
 *
 * * Zoom confidence measures source richness (how structured the summary email
 *   is), so the skip floor is lower. The action/decision thresholds still apply.
 */

// ── Per-domain confidence thresholds ──────────────────────────────────────────

/**
 * Action item confidence thresholds.
 * SKIP   < 0.35  — too noisy, discard
 * REVIEW 0.35–0.59 — create with needsReview=true
 * AUTO   ≥ 0.60  — auto-materialize (same as existing threshold)
 */
export const ACTION_CONFIDENCE = {
  SKIP: 0.35,
  AUTO: 0.60,
} as const;

/**
 * Decision record confidence thresholds.
 *
 * Decisions carry more weight than actions — a wrong one misdirects the whole
 * team. The auto-trust bar is higher.
 *
 * SKIP   < 0.45  — too uncertain to store
 * REVIEW 0.45–0.59 — create with needsReview=true
 * AUTO   ≥ 0.60  — auto-materialize
 */
export const DECISION_CONFIDENCE = {
  SKIP: 0.45,
  AUTO: 0.60,
} as const;

/**
 * Memory (inferred context) confidence thresholds.
 * SKIP   < 0.40
 * REVIEW 0.40–0.59 — create with needsReview=true
 * AUTO   ≥ 0.60  — auto-materialize
 */
export const MEMORY_CONFIDENCE = {
  SKIP: 0.40,
  AUTO: 0.60,
} as const;

/**
 * Minimum source-quality score for Zoom-sourced items to even attempt
 * materialization. Zoom confidence is about email richness, not item certainty,
 * so the floor is lower than email/Slack.
 */
export const ZOOM_FLOOR = 0.30;

// ── Review-floor constants (used in shouldMaterialize gates) ──────────────────

/**
 * Minimum confidence before attempting email materialization.
 * Between EMAIL_REVIEW_FLOOR and ACTION_CONFIDENCE.AUTO → needsReview=true.
 * Below EMAIL_REVIEW_FLOOR → skip.
 */
export const EMAIL_REVIEW_FLOOR = ACTION_CONFIDENCE.SKIP;  // 0.35

/** Same for Slack. */
export const SLACK_REVIEW_FLOOR = ACTION_CONFIDENCE.SKIP;  // 0.35

/** Minimum confidence before materializing Zoom-sourced items. */
export const ZOOM_REVIEW_FLOOR  = ZOOM_FLOOR;              // 0.30

// ── Tier classification ────────────────────────────────────────────────────────

export type ConfidenceTier = "auto" | "review" | "skip";

/** Returns the trust tier for an extracted action item. */
export function actionTier(confidence: number): ConfidenceTier {
  if (confidence >= ACTION_CONFIDENCE.AUTO) return "auto";
  if (confidence >= ACTION_CONFIDENCE.SKIP) return "review";
  return "skip";
}

/** Returns the trust tier for an extracted decision record. */
export function decisionTier(confidence: number): ConfidenceTier {
  if (confidence >= DECISION_CONFIDENCE.AUTO) return "auto";
  if (confidence >= DECISION_CONFIDENCE.SKIP) return "review";
  return "skip";
}

/** Returns the trust tier for an inferred memory item. */
export function memoryTier(confidence: number): ConfidenceTier {
  if (confidence >= MEMORY_CONFIDENCE.AUTO) return "auto";
  if (confidence >= MEMORY_CONFIDENCE.SKIP) return "review";
  return "skip";
}

/**
 * Trust tier for Zoom-sourced action items.
 *
 * Zoom confidence measures SOURCE RICHNESS (how structured the email is), not
 * per-item certainty — so the skip floor aligns with ZOOM_REVIEW_FLOOR (0.30)
 * rather than ACTION_CONFIDENCE.SKIP (0.35).  This closes the gap between the
 * floor gate and the generic action tier that would otherwise silently suppress
 * actions from emails with confidence 0.30–0.34.
 *
 * | Zoom confidence | Tier   | needsReview |
 * |-----------------|--------|-------------|
 * | < 0.30          | skip   | (discarded) |
 * | 0.30 – 0.59     | review | true        |
 * | ≥ 0.60          | auto   | false       |
 */
export function zoomActionTier(confidence: number): ConfidenceTier {
  if (confidence >= ACTION_CONFIDENCE.AUTO) return "auto";
  if (confidence >= ZOOM_REVIEW_FLOOR) return "review";
  return "skip";
}

/**
 * Trust tier for Zoom-sourced decision records.
 *
 * Same rationale as zoomActionTier — skip floor is ZOOM_REVIEW_FLOOR (0.30),
 * not DECISION_CONFIDENCE.SKIP (0.45).
 *
 * | Zoom confidence | Tier   | needsReview |
 * |-----------------|--------|-------------|
 * | < 0.30          | skip   | (discarded) |
 * | 0.30 – 0.69     | review | true        |
 * | ≥ 0.70          | auto   | false       |
 */
export function zoomDecisionTier(confidence: number): ConfidenceTier {
  if (confidence >= DECISION_CONFIDENCE.AUTO) return "auto";
  if (confidence >= ZOOM_REVIEW_FLOOR) return "review";
  return "skip";
}

/** Convenience: returns true if the item should be flagged for user review. */
export function needsReviewFlag(tier: ConfidenceTier): boolean {
  return tier === "review";
}
