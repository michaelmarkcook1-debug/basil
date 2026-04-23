/**
 * Canonical shared primitives for Basil domain entities.
 *
 * Import cross-cutting types from here rather than duplicating them in each
 * entity module. Entity files may re-export narrowed subsets; this file is the
 * single source of truth.
 */

// ── Source attribution ────────────────────────────────────────────────────────

/**
 * Where a piece of data originated. Used by ActionItem, Decision, Memory,
 * and BasilEvent so filtering and grouping by source is always consistent.
 *
 * Superset rule: entity-specific `source` fields should be assignable from
 * this type (a narrowed subset is fine; extending it is not).
 */
export type EntitySource =
  | "email"     // From an email thread
  | "slack"     // From a Slack message or DM
  | "calendar"  // From a calendar event
  | "meeting"   // Extracted from a meeting transcript / notes
  | "chat"      // Created during a Basil chat session
  | "manual"    // User-entered directly
  | "inferred"; // AI-inferred without explicit user action

// ── Provenance ────────────────────────────────────────────────────────────────

/**
 * Provenance block — attached to any entity derived from an external signal or
 * event. Keeps the audit trail intact when objects cross module boundaries.
 *
 * All fields are optional so this can be spread onto existing entities without
 * breaking stored records that predate the domain unification.
 */
export interface Provenance {
  /**
   * ID of the BasilEvent that produced this entity, if any.
   * Enables bidirectional navigation: event → object, object → event.
   */
  eventId?: string;
  /**
   * Stable reference to the originating record in the source system.
   * Uses the same format as BasilEvent.sourceRef, e.g. "gmail:1abc2def".
   */
  sourceRef?: string;
  /**
   * 0–1 confidence in the classification or extraction that produced this
   * entity. 1.0 = definitive (user-created or explicit rule match);
   * < 1.0 = AI-inferred or heuristic.
   */
  confidence?: number;
}

// ── Timestamps ────────────────────────────────────────────────────────────────

/**
 * Standard timestamp pair present on every persisted Basil entity.
 * New entities should implement this; legacy entities already match it.
 */
export interface Timestamped {
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 last-modification timestamp. Equal to createdAt on first save. */
  updatedAt: string;
}
