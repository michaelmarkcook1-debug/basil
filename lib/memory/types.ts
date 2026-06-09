export type MemoryKind = "fact" | "preference" | "person" | "context";

export interface Memory {
  id: string;
  kind: MemoryKind;
  /** One-line canonical fact. Keep it short, specific, decontextualised. */
  content: string;
  /** Optional entity this memory is about — e.g. "Riley Chen", "Example Analytics". */
  entity?: string;
  /** Where this came from: chat, briefing, manual, tool-inferred. */
  source: "chat" | "manual" | "inferred";
  createdAt: string;
  updatedAt: string;

  // ── Confidence ────────────────────────────────────────────────────────────
  /**
   * 0–1 confidence for inferred memories. Absent on manually-created items.
   * Inherits the source classification confidence that triggered materialization.
   */
  confidence?: number;
  /**
   * True when confidence is in the review band (0.40–0.59). Inferred memories
   * below the auto threshold are not shown in briefings as verified facts.
   */
  needsReview?: boolean;

  // ── Provenance (optional — absent on records predating domain unification) ─
  /** ID of the BasilEvent that produced this memory, if created via the event pipeline. */
  eventId?: string;
  /** Stable reference to the originating record in the source system (e.g. "gmail:1abc2def"). */
  sourceRef?: string;
}

export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  fact: "Fact",
  preference: "Preference",
  person: "Person",
  context: "Context",
};
