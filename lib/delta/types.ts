/**
 * Delta-awareness system types.
 *
 * A ChangeEvent is a single detected operational change, computed by comparing
 * the current state of actions / decisions / contacts / threads against a
 * time-window baseline.
 *
 * Design constraints:
 *   - Changes are computed on-read, not streamed
 *   - No full-state snapshots required — changes are inferred from timestamps
 *   - Continuous signals (silence, pending items) are surfaced as "current state"
 *   - Baseline is just a single "last seen" timestamp per user
 */

// ── Change categories ─────────────────────────────────────────────────────────

/**
 * The operational domain this change belongs to.
 *
 *   relationship — contact engagement shift (silence, re-engagement)
 *   urgency      — deadline, escalation, overdue, blocker removed
 *   operational  — new commitment, decision logged, review needed
 *   confidence   — trust tier shift, contradiction detected
 *   momentum     — thread activity, signal cluster growth
 */
export type ChangeCategory =
  | "relationship"
  | "urgency"
  | "operational"
  | "confidence"
  | "momentum";

/**
 * Severity of the change — drives visual hierarchy and ranking.
 *
 *   critical — must be seen today (overdue, blocked, high-severity conflict)
 *   high     — important but not immediately blocking
 *   medium   — worth knowing, doesn't require immediate action
 *   low      — informational, easy to miss
 */
export type ChangeSeverity = "critical" | "high" | "medium" | "low";

// ── ChangeEvent ───────────────────────────────────────────────────────────────

export interface ChangeEvent {
  /** Stable deterministic ID for dedup — sha of (source + entityId + field + window). */
  id: string;

  /** Which operational domain this belongs to. */
  category: ChangeCategory;

  /** How important this change is. Drives visual hierarchy. */
  severity: ChangeSeverity;

  /**
   * Composite ranking score — 0–1.
   * Higher = surface first. Combines severity × category weight × recency.
   */
  score: number;

  /**
   * Short, scannable title. One line.
   * e.g. "Action overdue", "Stakeholder silent", "Decision logged"
   */
  title: string;

  /**
   * One-line context giving the specific entity and detail.
   * e.g. "AG demo deck — was low priority, deadline passed"
   */
  context: string;

  /**
   * Operational implication — what this means for work.
   * e.g. "→ 2 actions unblocked", "→ Thread re-activated"
   * Optional — only set when a clear downstream consequence exists.
   */
  implication?: string;

  /** When this change occurred or was detected (ISO8601). */
  occurredAt: string;

  /** Source store that generated this change. */
  source: "actions" | "decisions" | "events" | "contacts" | "threads" | "signals";

  /** ID of the linked entity (action id, decision id, contact id, etc.). */
  entityId?: string;

  /** Direct deep-link to the entity in the dashboard. */
  entityHref?: string;

  /** What specifically changed (field, from, to). */
  delta: {
    field: string;
    from?: string;
    to?: string;
  };

  /** Whether the user has explicitly seen this change. */
  seen: boolean;
}

// ── Delta baseline ────────────────────────────────────────────────────────────

/**
 * Per-user baseline record.
 * Stored at sage-delta-baseline.json — just a timestamp.
 * Marks the last time the user reviewed the "What Changed" surface.
 */
export interface DeltaBaseline {
  /**
   * ISO8601 — when the user last marked all changes as seen.
   * Changes older than this timestamp have been reviewed.
   */
  lastSeenAt: string;

  /**
   * ISO8601 — when this record was created.
   */
  createdAt: string;
}

// ── API response ──────────────────────────────────────────────────────────────

export interface ChangesResponse {
  changes: ChangeEvent[];
  total: number;
  unseenCount: number;
  /** The baseline timestamp changes are measured from. */
  since: string;
  /** ISO8601 of when this response was generated. */
  generatedAt: string;
  /** Time buckets for UI grouping. */
  buckets: ChangeBucket[];
}

export interface ChangeBucket {
  label: string;        // "Today", "Yesterday", "This week", "Earlier"
  changes: ChangeEvent[];
}

// ── Category config (shared by compute + UI) ──────────────────────────────────

export const CATEGORY_CONFIG: Record<
  ChangeCategory,
  { label: string; weight: number; colorClass: string; dotClass: string; bgClass: string }
> = {
  urgency: {
    label: "Urgency",
    weight: 1.00,
    colorClass: "text-red-600 dark:text-red-400",
    dotClass: "bg-red-500",
    bgClass: "bg-red-500/10 dark:bg-red-950/30",
  },
  relationship: {
    label: "Relationship",
    weight: 0.90,
    colorClass: "text-blue-600 dark:text-blue-400",
    dotClass: "bg-blue-500",
    bgClass: "bg-blue-500/10 dark:bg-blue-950/30",
  },
  operational: {
    label: "Operational",
    weight: 0.75,
    colorClass: "text-[oklch(0.58_0.15_85)] dark:text-[oklch(0.72_0.15_85)]",
    dotClass: "bg-[oklch(0.72_0.15_85)]",
    bgClass: "bg-[oklch(0.72_0.15_85)]/10",
  },
  confidence: {
    label: "Confidence",
    weight: 0.65,
    colorClass: "text-violet-600 dark:text-violet-400",
    dotClass: "bg-violet-500",
    bgClass: "bg-violet-500/10 dark:bg-violet-950/30",
  },
  momentum: {
    label: "Momentum",
    weight: 0.55,
    colorClass: "text-emerald-600 dark:text-emerald-400",
    dotClass: "bg-emerald-500",
    bgClass: "bg-emerald-500/10 dark:bg-emerald-950/30",
  },
};

export const SEVERITY_WEIGHT: Record<ChangeSeverity, number> = {
  critical: 1.00,
  high:     0.75,
  medium:   0.50,
  low:      0.25,
};
