/**
 * lib/learning/types.ts
 *
 * Interaction-driven learning. Every engagement the user makes on an item
 * (done / push / delegate / delete / opened) is logged as a labelled signal.
 * Patterns over those signals drive suggestions — starting with "you keep
 * deleting everything from this Slack channel; mute it?".
 *
 * Design stance: observe → infer → PROPOSE → confirm → adapt. The system never
 * silently suppresses a source; it asks, and every learned rule is reversible.
 */

export type InteractionAction = "done" | "push" | "delegate" | "delete" | "opened";

export interface InteractionEvent {
  id: string;
  /** The action/item id this interaction was on. */
  itemId: string;
  /** Normalised source key — "slack:C123" | "email" | "linear" | "manual" | … */
  sourceKey: string;
  /** Optional category/tag of the item, for category-level learning later. */
  category?: string;
  action: InteractionAction;
  ts: string; // ISO8601
}

/** A user's standing preference for a source, learned + confirmed. */
export interface SourcePreference {
  sourceKey: string;
  sourceLabel?: string;
  /** "muted" = suspend ingestion; "demoted" = keep ingesting but lower priority. */
  state: "muted" | "demoted";
  since: string; // ISO8601
  /** Optional auto-expiry (e.g. "mute for 30 days"). */
  until?: string; // ISO8601
}

/** Records that we offered a suggestion for a source and the user said "not now". */
export interface SuggestionDismissal {
  sourceKey: string;
  ts: string; // ISO8601
}

export interface LearningStore {
  events: InteractionEvent[];
  preferences: SourcePreference[];
  dismissals: SuggestionDismissal[];
}

export const EMPTY_LEARNING_STORE: LearningStore = {
  events: [],
  preferences: [],
  dismissals: [],
};

/** A "suspend this noisy source?" suggestion surfaced to the user. */
export interface MuteSuggestion {
  sourceKey: string;
  sourceLabel: string;
  deletes: number;
  total: number;
  windowDays: number;
}
