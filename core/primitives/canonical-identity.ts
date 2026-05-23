/**
 * Primitive 6 — CanonicalIdentity
 *
 * A stable, deduplicated record for a person or entity that appears across
 * multiple signal sources. Each unique person gets exactly one CanonicalIdentity
 * regardless of how many email addresses, display name variations, or source
 * systems they appear in.
 *
 * Relationship to SignalEvent:
 *   EntityRef.canonicalId → CanonicalIdentity.id
 *   Populated by the identity-resolution pass (gated on canonicalIdentity_active)
 *
 * Resolution strategy (Week 2 foundation — resolver implemented in Week 3):
 *   1. Exact match on primaryEmail (normalized to lowercase)
 *   2. Alias match (any email in aliases[])
 *   3. Fuzzy display name match within the same company domain (future)
 *   4. If no match: create new identity
 *
 * Storage: "sage-canonical-identities.json" per user
 *
 * Guardrails:
 *   - IDs are stable: sha256(primaryEmail) → 16-char hex
 *   - Merge is manual — never auto-merge without human confirmation
 *   - Relationship strength decays independently of signal decay
 */

import type { SignalSource } from "./signal-event";

// ── CanonicalIdentity ─────────────────────────────────────────────────────────

export interface CanonicalIdentity {
  /**
   * Stable ID — sha256(primaryEmail.toLowerCase()), hex-truncated to 16 chars.
   * Survives renames and email updates as long as primaryEmail is stable.
   */
  id: string;

  /**
   * The most authoritative known email address for this person.
   * Always lowercase. Chosen at creation time from the first signal's sender.
   */
  primaryEmail: string;

  /**
   * Best-known display name for this person.
   * Updated when a higher-confidence signal provides a better name.
   */
  displayName: string;

  /**
   * All other known email addresses and name variations for this person.
   * Used for alias matching during resolution.
   */
  aliases: string[];

  /** Company or organization this person is associated with. */
  company?: string;

  /** Their role or title, as inferred from signals. */
  role?: string;

  /** ISO8601 — when this identity was first created. */
  firstSeenAt: string;

  /** ISO8601 — when the most recent signal from this person was processed. */
  lastSeenAt: string;

  /** Total number of signals this identity has appeared in (as any participant role). */
  signalCount: number;

  /**
   * Which sources have generated signals involving this identity.
   * Used for cross-source deduplication.
   */
  seenInSources: SignalSource[];

  // ── Relationship intelligence ─────────────────────────────────────────────

  /**
   * Relationship strength 0–1. Computed from interaction frequency and recency.
   * Decays toward 0 over time when no new signals arrive.
   * Half-life: approximately 90 days.
   */
  relationshipStrength: number;

  /**
   * ISO8601 — when the most recent direct interaction (email send/receive,
   * meeting attendance) occurred. Used for relationship decay.
   */
  lastInteractionAt?: string;

  /**
   * Number of direct interactions (emails, meetings).
   * Does not count mentions or CC appearances.
   */
  directInteractionCount: number;

  // ── Merge provenance ──────────────────────────────────────────────────────

  /**
   * IDs of CanonicalIdentity records that were merged into this one.
   * Preserved for audit trail.
   */
  mergedFromIds: string[];

  /**
   * ISO8601 — when this record was last updated.
   */
  updatedAt: string;
}

// ── Identity store key ────────────────────────────────────────────────────────

export const CANONICAL_IDENTITY_FILE = "sage-canonical-identities.json";

// ── Builder ───────────────────────────────────────────────────────────────────

/**
 * Build a new CanonicalIdentity from first-seen signal data.
 * Does not write to storage — caller is responsible for persistence.
 */
export function buildCanonicalIdentity(opts: {
  id: string;
  primaryEmail: string;
  displayName: string;
  source: SignalSource;
  company?: string;
  role?: string;
}): CanonicalIdentity {
  const now = new Date().toISOString();
  return {
    id: opts.id,
    primaryEmail: opts.primaryEmail.toLowerCase(),
    displayName: opts.displayName,
    aliases: [],
    company: opts.company,
    role: opts.role,
    firstSeenAt: now,
    lastSeenAt: now,
    signalCount: 1,
    seenInSources: [opts.source],
    relationshipStrength: 0.1,   // weak until corroborated
    lastInteractionAt: now,
    directInteractionCount: 1,
    mergedFromIds: [],
    updatedAt: now,
  };
}

/**
 * Merge a new signal observation into an existing CanonicalIdentity.
 * Returns the updated record — does not write to storage.
 *
 * Updates:
 *   - lastSeenAt, signalCount, seenInSources
 *   - directInteractionCount if isDirect
 *   - lastInteractionAt if isDirect
 *   - relationshipStrength (recency bump, capped at 1.0)
 *   - aliases (if displayName or email is new)
 */
export function mergeObservation(
  identity: CanonicalIdentity,
  observation: {
    seenEmail?: string;
    seenName?: string;
    source: SignalSource;
    isDirect: boolean;
    observedAt: string;
  }
): CanonicalIdentity {
  const now = new Date().toISOString();
  const updated = { ...identity, updatedAt: now };

  updated.lastSeenAt = now;
  updated.signalCount += 1;

  // Add source if new
  if (!updated.seenInSources.includes(observation.source)) {
    updated.seenInSources = [...updated.seenInSources, observation.source];
  }

  // Track aliases
  if (
    observation.seenEmail &&
    observation.seenEmail.toLowerCase() !== updated.primaryEmail &&
    !updated.aliases.includes(observation.seenEmail.toLowerCase())
  ) {
    updated.aliases = [...updated.aliases, observation.seenEmail.toLowerCase()];
  }
  if (
    observation.seenName &&
    observation.seenName !== updated.displayName &&
    !updated.aliases.includes(observation.seenName)
  ) {
    updated.aliases = [...updated.aliases, observation.seenName];
  }

  // Direct interaction boost
  if (observation.isDirect) {
    updated.directInteractionCount += 1;
    updated.lastInteractionAt = observation.observedAt;
    // Recency bump: nudge strength toward 1.0 (capped)
    updated.relationshipStrength = Math.min(
      1.0,
      updated.relationshipStrength + 0.05
    );
  }

  return updated;
}
