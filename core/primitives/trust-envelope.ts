/**
 * Primitive 2 — TrustEnvelope
 *
 * Every signal that enters Basil carries a TrustEnvelope describing how
 * confident we are in it, where it came from, and whether it has been
 * corroborated or contradicted by other signals.
 *
 * NOTE on terminology:
 *   The existing lib/trust/policy.ts uses "skip" as the third tier.
 *   The canonical primitive uses "blocked" — semantically clearer.
 *   Migration: lib/trust/policy.ts will be updated to use TrustTier
 *   once all callers have been migrated to the canonical primitive.
 */

import type { SignalSource } from "./signal-event";

// ── Trust tier ────────────────────────────────────────────────────────────────

/**
 * Canonical trust tier — controls whether a signal is auto-written,
 * queued for human review, or blocked entirely.
 *
 *   auto    — materialize immediately, no user gate
 *   review  — materialize with needsReview=true; user can confirm or dismiss
 *   blocked — discard; confidence too low or sender unknown
 */
export type TrustTier = "auto" | "review" | "blocked";

// ── Source quality weights ────────────────────────────────────────────────────

/**
 * Pre-computed quality weight per signal source.
 * Higher = more trustworthy as a source of intelligence.
 * Used as a multiplier on base confidence.
 */
export const SOURCE_WEIGHTS: Record<SignalSource, number> = {
  calendar: 0.90,   // deterministic, no ambiguity
  zoom:     0.90,   // audio + transcript, high fidelity
  gmail:    0.80,   // structured, but phishing risk
  outlook:  0.80,   // same as gmail
  drive:    0.75,   // activity signals, less rich
  onedrive: 0.75,
  linear:   0.85,   // explicit work items, very reliable
  slack:    0.70,   // conversational, higher noise
  teams:    0.70,
  whatsapp: 0.60,   // least structured, highest ambiguity
};

// ── Provenance ────────────────────────────────────────────────────────────────

/** One entry in the provenance chain — a single source that contributed. */
export interface Provenance {
  source: SignalSource;
  /** Human-readable reference: "gmail:thread-abc123" */
  sourceRef: string;
  extractedAt: string;                       // ISO8601
  extractedBy: "ai" | "rule" | "human";
  /** Which model tier was used if extracted by AI */
  modelTier?: "fast" | "balanced" | "deep";
  /** Confidence at the time of this extraction */
  confidence: number;
}

// ── Contradiction ─────────────────────────────────────────────────────────────

/** Flagged when this signal contradicts an existing signal. */
export interface ContradictionFlag {
  /** SignalEvent.id of the contradicting signal */
  conflictsWith: string;
  /** Which field or claim contradicts (e.g. "status", "commitment") */
  field: string;
  detectedAt: string;
  severity: "low" | "medium" | "high";
}

// ── TrustEnvelope ─────────────────────────────────────────────────────────────

export interface TrustEnvelope {
  /**
   * Current effective confidence — composite of base confidence,
   * freshness decay, and source weight.
   * Range: 0–1. Recomputed on read when freshnessScore changes.
   */
  confidence: number;

  /** Full provenance chain — every source that contributed to this signal. */
  provenance: Provenance[];

  /**
   * How many independent signals corroborate this one.
   * 0 = only one source, 3+ = high confidence cluster.
   */
  corroborationCount: number;

  /**
   * Freshness decay score — 1.0 when new, decays toward 0 over time.
   * Half-life varies by signal type (see core/trust/decay.ts).
   */
  freshnessScore: number;

  /** Detected contradictions with other signals in the store. */
  contradictionFlags: ContradictionFlag[];

  /**
   * Trust tier — controls materialization behaviour.
   * Derived from confidence + sender knowledge + contradiction count.
   */
  trustTier: TrustTier;

  /**
   * Pre-computed source quality weight from SOURCE_WEIGHTS.
   * Embedded here so ranking and decay can use it without re-lookup.
   */
  sourceWeight: number;

  /** When this envelope was first computed (ISO8601). */
  createdAt: string;

  /** When a corroborating signal last touched this (ISO8601). */
  lastCorroboratedAt?: string;

  /** Decay half-life in days (signal-type dependent). */
  decayHalfLifeDays: number;
}

// ── Half-life constants ───────────────────────────────────────────────────────

export const DECAY_HALF_LIFE_DAYS = {
  email:           14,
  message:          7,  // slack / teams / whatsapp
  meeting:         30,
  document_change: 21,
  issue:           60,  // linear issues stay relevant longer
  calendar_event:   3,  // past events decay fast
} as const;

// ── Builder helpers ───────────────────────────────────────────────────────────

/**
 * Compute a freshness score from creation timestamp and half-life.
 * Returns 1.0 for brand-new signals, approaching 0 as age grows.
 */
export function computeFreshness(createdAt: string, halfLifeDays: number): number {
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / 86_400_000;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/**
 * Effective confidence = base × freshness × sourceWeight.
 * This is the value that should be used for trust-tier decisions
 * at query time (not at write time, since freshness changes daily).
 */
export function effectiveConfidence(envelope: TrustEnvelope): number {
  return Math.min(
    1,
    envelope.confidence * envelope.freshnessScore * envelope.sourceWeight
  );
}

/**
 * Determine trust tier from effective confidence.
 * Thresholds mirror lib/trust/policy.ts but use the canonical tier names.
 * Unknown-sender signals require a higher bar (anti-phishing guard).
 */
export function determineTrustTier(
  confidence: number,
  artifactType: "action" | "decision" | "memory" | "zoom",
  senderIsKnown: boolean
): TrustTier {
  const thresholds = TIER_THRESHOLDS[senderIsKnown ? artifactType : "unknownSender"];
  if (confidence >= thresholds.auto) return "auto";
  if (confidence >= thresholds.review) return "review";
  return "blocked";
}

const TIER_THRESHOLDS = {
  action:        { auto: 0.60, review: 0.35 },
  decision:      { auto: 0.70, review: 0.45 },
  memory:        { auto: 0.60, review: 0.40 },
  zoom:          { auto: 0.60, review: 0.30 },
  unknownSender: { auto: 0.85, review: 0.70 }, // higher bar — anti-phishing
} as const;

/**
 * Build a fresh TrustEnvelope for a new signal.
 */
export function buildTrustEnvelope(opts: {
  source: SignalSource;
  sourceRef: string;
  confidence: number;
  halfLifeDays: number;
  senderIsKnown?: boolean;
  artifactType?: "action" | "decision" | "memory" | "zoom";
  extractedBy?: Provenance["extractedBy"];
  modelTier?: Provenance["modelTier"];
}): TrustEnvelope {
  const now = new Date().toISOString();
  const sourceWeight = SOURCE_WEIGHTS[opts.source];
  const freshnessScore = 1.0; // brand new

  const provenance: Provenance = {
    source: opts.source,
    sourceRef: opts.sourceRef,
    extractedAt: now,
    extractedBy: opts.extractedBy ?? "ai",
    modelTier: opts.modelTier,
    confidence: opts.confidence,
  };

  const trustTier = determineTrustTier(
    opts.confidence * sourceWeight,
    opts.artifactType ?? "memory",
    opts.senderIsKnown ?? true
  );

  return {
    confidence: opts.confidence,
    provenance: [provenance],
    corroborationCount: 0,
    freshnessScore,
    contradictionFlags: [],
    trustTier,
    sourceWeight,
    createdAt: now,
    decayHalfLifeDays: opts.halfLifeDays,
  };
}
