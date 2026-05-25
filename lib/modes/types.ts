/**
 * Operational Mode system types.
 *
 * Modes are operational contexts — not pages.
 * They alter prioritisation, surfaced signals, interruption behaviour,
 * and attention weighting across every surface in the dashboard.
 *
 * Design invariants:
 *   - "default" is always a valid mode (no filtering applied)
 *   - Modes are stateless configs; ephemeral state lives in ModeState
 *   - No component is required to consume mode context — graceful fallback
 *   - Severity ordering: critical > high > medium > low
 */

import type { ChangeCategory, ChangeSeverity } from "@/lib/delta/types";

// Re-export for consumers that import everything from modes/types
export type { ChangeCategory, ChangeSeverity };

// ── Mode identifiers ──────────────────────────────────────────────────────────

export type ModeId =
  | "default"
  | "focus"
  | "coordination"
  | "meeting"
  | "inbox-recovery"
  | "deep-work"
  | "daily-briefing";

// ── Attention taxonomy (mirrors AttentionLayer types) ─────────────────────────

export type AttentionPriority = "critical" | "high" | "medium" | "low";
export type AttentionType = "commitment" | "approval" | "blocker" | "relationship" | "meeting" | "silence" | "pressure";

// ── Mode behaviour spec ───────────────────────────────────────────────────────

export interface ModeBehavior {
  /**
   * Minimum severity to surface in feeds.
   * Items below this threshold are hidden.
   * null = show everything.
   */
  minSeverity: ChangeSeverity | null;

  /**
   * Minimum severity to treat as an interruption.
   * Items below this threshold are rendered passively.
   */
  interruptThreshold: ChangeSeverity;

  /**
   * Categories to actively suppress (even if above minSeverity).
   * Empty = suppress nothing.
   */
  suppressedCategories: ChangeCategory[];

  /**
   * Per-category attention weight multipliers.
   * >1.0 = boost (surface higher), <1.0 = demote, 0 = hide.
   * Unspecified categories default to 1.0.
   */
  attentionWeights: Partial<Record<ChangeCategory, number>>;

  /**
   * Attention-type weights for the AttentionLayer.
   * Maps AttentionItem.type to a multiplier.
   */
  attentionTypeWeights: Partial<Record<AttentionType, number>>;

  /**
   * Whether to show the "What Changed" delta surface.
   */
  showDelta: boolean;

  /**
   * Whether to show the relationship tracking section.
   */
  showRelationships: boolean;
}

// ── Mode config ───────────────────────────────────────────────────────────────

export interface ModeConfig {
  id: ModeId;

  /** Display name */
  label: string;

  /** Short label for compact UI (≤12 chars) */
  shortLabel: string;

  /** One-line description */
  description: string;

  /** Two-line operational hint — shown in the active mode banner */
  hint: string;

  /** Lucide icon component name */
  iconName: string;

  /** Tailwind color class for the mode indicator dot/text */
  colorClass: string;

  /** Tailwind bg class for the mode banner/card */
  bgClass: string;

  /** Tailwind border color class */
  borderClass: string;

  /** Operational behaviour */
  behavior: ModeBehavior;

  /** Suggested duration in minutes. undefined = no timer. */
  suggestedDuration?: number;

  /** Keyboard shortcut character (e.g. "F" for Focus) */
  shortcut?: string;
}

// ── Ephemeral mode state (persisted to localStorage) ─────────────────────────

export interface ModeState {
  /** Active mode ID */
  active: ModeId;

  /** ISO timestamp when the mode was activated */
  activeSince: string | null;

  /** ISO timestamp when the mode should auto-expire. null = no expiry. */
  activeUntil: string | null;

  /** Previous mode (for quick back-navigation) */
  previousMode: ModeId | null;
}

// ── Context value ─────────────────────────────────────────────────────────────

export interface ModeContextValue {
  /** Active mode configuration */
  mode: ModeConfig;

  /** Raw persisted state */
  state: ModeState;

  /** Activate a mode, optionally with a duration in minutes */
  setMode: (id: ModeId, durationMins?: number) => void;

  /** Return to default mode */
  clearMode: () => void;

  /** True when the active mode is "default" */
  isDefault: boolean;

  /** Minutes remaining in the current timed mode. null = no timer. */
  minutesRemaining: number | null;

  // ── Behaviour helpers ─────────────────────────────────────────────────────

  /**
   * Whether a ChangeEvent should be visible in the current mode.
   */
  shouldShowChange: (severity: ChangeSeverity, category: ChangeCategory) => boolean;

  /**
   * Whether an AttentionLayer item should be visible in the current mode.
   */
  shouldShowAttention: (priority: AttentionPriority, type: AttentionType) => boolean;

  /**
   * Whether a severity level should be treated as an interruption.
   */
  shouldInterrupt: (severity: ChangeSeverity | AttentionPriority) => boolean;

  /**
   * Attention weight multiplier for a category (default 1.0).
   */
  attentionWeight: (category: ChangeCategory) => number;

  /**
   * Attention weight multiplier for an attention type (default 1.0).
   */
  attentionTypeWeight: (type: AttentionType) => number;
}
