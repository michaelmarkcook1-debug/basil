/**
 * Basil OS — Canonical Primitives
 *
 * Central re-export for all core primitive types and builders.
 *
 * Import order follows dependency graph:
 *   SignalSource (signal-event) → TrustEnvelope → SignalEvent
 *
 * All future primitives (CanonicalIdentity, SignalThread, DispatchRequest,
 * RankedSignal, IntelligenceContext) will be added here as they are built.
 */

// ── Primitive 1 — SignalEvent ─────────────────────────────────────────────────
export type {
  SignalSource,
  SignalEventType,
  SignalCategory,
  EntityRef,
  ExtractedAction,
  ExtractedDecision,
  ExtractedMemory,
  SignalEvent,
} from "./signal-event";

// ── Primitive 2 — TrustEnvelope ───────────────────────────────────────────────
export type {
  TrustTier,
  Provenance,
  ContradictionFlag,
  TrustEnvelope,
} from "./trust-envelope";

export {
  SOURCE_WEIGHTS,
  DECAY_HALF_LIFE_DAYS,
  computeFreshness,
  effectiveConfidence,
  determineTrustTier,
  buildTrustEnvelope,
} from "./trust-envelope";
