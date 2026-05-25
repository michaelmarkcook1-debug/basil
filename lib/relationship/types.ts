/**
 * Relationship intelligence types.
 *
 * Models operational health of a working relationship as observed through
 * communication signals — not sentiment, not social engagement, not scores.
 *
 * Design invariants:
 *   - Health is always multi-dimensional. No single number tells the story.
 *   - Every state must be explainable from the underlying signals.
 *   - Signals are inferred from timestamps and counts — not from content.
 *   - "Unknown" is a valid and honest state when data is insufficient.
 */

// ── Health states ─────────────────────────────────────────────────────────────

/**
 * The five operational states of a working relationship.
 *
 * Ordered by health descending:
 *   strengthening → stable → cooling → critical → disengaged
 *
 * "unknown" is used when signals are insufficient for a reliable assessment.
 */
export type HealthState =
  | "strengthening"
  | "stable"
  | "cooling"
  | "critical"
  | "disengaged"
  | "unknown";

// ── Health trend ──────────────────────────────────────────────────────────────

/** Direction of change over the most recent observation window. */
export type HealthTrend = "improving" | "stable" | "declining";

// ── Signal dimensions ─────────────────────────────────────────────────────────

/**
 * The five dimensions used to assess thread health.
 *
 *   silence       — days since the last signal (most diagnostic)
 *   momentum      — signal frequency relative to thread baseline
 *   commitments   — open/unresolved action items from this thread
 *   vitality      — thread status and stale detection
 *   depth         — signal volume relative to relationship age
 */
export type HealthDimension =
  | "silence"
  | "momentum"
  | "commitments"
  | "vitality"
  | "depth";

/** Signal quality status — drives row colour in the health panel. */
export type SignalStatus = "healthy" | "neutral" | "warning" | "critical";

// ── Individual signal ─────────────────────────────────────────────────────────

export interface HealthSignal {
  /** Which dimension this signal measures. */
  dimension: HealthDimension;

  /** Short scannable label. e.g. "Last contact" */
  label: string;

  /** Human-readable value. e.g. "8 days ago", "2 unresolved" */
  value: string;

  /**
   * Normalised score for this dimension: 0–100.
   * 100 = ideal, 0 = critical.
   */
  score: number;

  /** Visual status — drives colour coding. */
  status: SignalStatus;

  /** Direction of change. Present when a trend can be detected. */
  trend?: HealthTrend;

  /** One-line explanation of why this score was assigned. */
  explanation?: string;
}

// ── Operational alert ─────────────────────────────────────────────────────────

export type AlertSeverity = "info" | "warning" | "critical";

export interface HealthAlert {
  /** Stable ID — used for deduplication and dismissal. */
  id: string;

  severity: AlertSeverity;

  /** Short operational message. Plain language, no jargon. */
  message: string;

  /** Optional CTA label. */
  actionLabel?: string;

  /** Optional CTA href. */
  actionHref?: string;
}

// ── Thread health ─────────────────────────────────────────────────────────────

export interface ThreadHealth {
  /** The assessed health state. */
  state: HealthState;

  /**
   * Composite health score: 0–100.
   * Not shown as a number in the UI — used only for ranking and state derivation.
   */
  score: number;

  /** Direction of change from the previous observation window. */
  trend: HealthTrend;

  /** Individual dimension signals. */
  signals: HealthSignal[];

  /** Actionable alerts derived from the signals. */
  alerts: HealthAlert[];

  /** ISO timestamp when this assessment was computed. */
  computedAt: string;

  /**
   * True when the data is sufficient for a reliable assessment.
   * False = show "Insufficient data" rather than a potentially misleading state.
   */
  reliable: boolean;
}

// ── Scoring inputs ────────────────────────────────────────────────────────────

/**
 * Raw inputs to the health scoring engine.
 * Computed from SignalThread + related ActionItems.
 */
export interface ThreadHealthInput {
  // Timing
  /** Days since the most recent signal. */
  daysSinceLastSignal: number;

  /** Total age of the relationship in days (first signal → now). */
  relationshipAgeDays: number;

  /** Total signals ever recorded. */
  totalSignalCount: number;

  // Frequency
  /** Signals in the most recent 30-day window. */
  signalsLast30Days: number;

  /** Signals in the 30 days before that. */
  signalsPrev30Days: number;

  // Commitments
  /** Open/unresolved action items from this thread. */
  unresolvedCommitmentCount: number;

  /** Age in days of the oldest unresolved commitment. null if none. */
  oldestUnresolvedDays: number | null;

  // Status
  /** Raw thread status from the store. */
  threadStatus: "open" | "stale" | "closed";

  /** Number of distinct sources (Gmail, Slack, etc.). */
  sourceCount: number;
}

// ── Contact health (for relationship card) ────────────────────────────────────

/**
 * Health of a contact-level relationship — aggregated across all threads
 * involving that contact.
 */
export interface ContactHealth {
  contactId: string;
  name: string;
  state: HealthState;
  trend: HealthTrend;
  primaryAlert?: string;
  daysSinceContact: number | null;
  unresolvedCommitments: number;
}
