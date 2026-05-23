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

// ── Primitive 6 — CanonicalIdentity ──────────────────────────────────────────
export type { CanonicalIdentity } from "./canonical-identity";
export {
  CANONICAL_IDENTITY_FILE,
  buildCanonicalIdentity,
  mergeObservation,
} from "./canonical-identity";

// ── Primitive 5 — RankedSignal ────────────────────────────────────────────────
export type { RankedSignal } from "./ranked-signal";
export { RANKING_WEIGHTS, SURFACE_THRESHOLD, DIGEST_THRESHOLD } from "./ranked-signal";

// ── Primitive 4 — SignalThread ────────────────────────────────────────────────
export type {
  SignalThreadStatus,
  SignalThread,
} from "./signal-thread";
export { buildSignalThread, addSignalToThread } from "./signal-thread";

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
