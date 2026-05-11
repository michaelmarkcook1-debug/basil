/**
 * Basil shared ledger — canonical cross-module item types.
 * Every item in the ledger has source attribution and cross-references.
 */

export type LedgerItemType =
  | "action"
  | "decision"
  | "memory"
  | "project"
  | "meeting"
  | "briefing_item"
  | "ai_task"
  | "follow_up";

export type LedgerSource =
  | "slack"
  | "email"
  | "calendar"
  | "chat"
  | "stig"
  | "briefing"
  | "manual"
  | "zoom"
  | "teams"
  | "notion"
  | "linear"
  | "github"
  | "ai_project";

export type LedgerItemStatus =
  | "open"
  | "in_progress"
  | "done"
  | "cancelled"
  | "blocked";

export type CreatedBy = "user" | "basil" | "integration" | "ai";

export interface LedgerItem {
  id: string;
  type: LedgerItemType;
  title: string;
  summary?: string;
  source: LedgerSource;
  /** IDs of source items (Slack message IDs, email IDs, etc.) */
  sourceIds: string[];
  /** The externalId of the originating event if any */
  sourceRef?: string;
  relatedPeople: string[];
  relatedProjects: string[];
  status: LedgerItemStatus;
  createdAt: string;
  updatedAt: string;
  dueAt?: string;
  confidence?: number;
  urgency?: "low" | "medium" | "high" | "critical";
  createdBy: CreatedBy;
  workspace?: string;
  /** ID of the corresponding Action/Decision/Memory item if converted */
  convertedTo?: { type: string; id: string };
}

export interface LedgerConvertRequest {
  ledgerItemId: string;
  targetType: "action" | "decision" | "memory" | "project";
  /** Override title for the converted item */
  title?: string;
  /** Override summary */
  summary?: string;
  dueAt?: string;
}
