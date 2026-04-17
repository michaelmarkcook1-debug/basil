export type MemoryKind = "fact" | "preference" | "person" | "context";

export interface Memory {
  id: string;
  kind: MemoryKind;
  /** One-line canonical fact. Keep it short, specific, decontextualised. */
  content: string;
  /** Optional entity this memory is about — e.g. "Isaac Frank", "AnalystGenius". */
  entity?: string;
  /** Where this came from: chat, briefing, manual, tool-inferred. */
  source: "chat" | "manual" | "inferred";
  createdAt: string;
  updatedAt: string;
}

export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  fact: "Fact",
  preference: "Preference",
  person: "Person",
  context: "Context",
};
