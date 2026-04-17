// Basil event model: anything that might deserve Michael's attention — an email,
// a Slack message, a calendar change. Each event gets classified by the rules
// engine into one of three dispositions (auto / draft / notify) and flows
// through a single queue that drives the dashboard widget + approval panel.

export type EventSource = "email" | "slack" | "calendar" | "drive" | "manual";

export type EventDisposition =
  | "auto" // Basil acted — no user attention required, just a record
  | "draft" // Basil prepared a response, awaits approval
  | "notify"; // High-signal heads-up — no action queued, just surface it

export type EventStatus =
  | "pending" // draft awaiting approval
  | "approved"
  | "rejected"
  | "executed" // auto actions land here immediately
  | "acknowledged"; // notify events Michael has seen

export type EventPriority = "high" | "normal" | "low";

export interface BasilEvent {
  id: string;
  /** Stable external id from the source system (gmail message id, slack ts+channel, calendar event id).
   *  Used to dedupe so re-polling doesn't create duplicate Basil events. */
  externalId?: string;
  source: EventSource;
  /** Short headline Basil would say out loud: "New email from Malcolm about AG v1" */
  headline: string;
  /** Full context Basil used to decide — pasted into the approval card. */
  context: string;
  /** If set, Basil prepared a draft of a response. */
  draft?: {
    channel: "email" | "slack";
    to: string;
    subject?: string;
    body: string;
  };
  /** Person this event is about — used for avatar + relationship updates. */
  entityName?: string;
  disposition: EventDisposition;
  priority: EventPriority;
  status: EventStatus;
  /** Reasoning Basil used, shown in the "why" section of the approval card. */
  rationale: string;
  createdAt: string;
  updatedAt: string;
  /** Free-form tags — "money", "legal", "hiring", "decision", etc. */
  tags: string[];
}

export interface IngestPayload {
  source: EventSource;
  /** Stable external id. If present, ingest will dedupe against previously-seen events. */
  externalId?: string;
  /** Title / subject. */
  title: string;
  /** Body / message text. */
  body: string;
  from?: string;
  channel?: string;
  /** Extra hints the rules engine can use. */
  hints?: {
    isDM?: boolean;
    isGroupDM?: boolean;
    isMention?: boolean;
    isFromKeyPerson?: boolean;
  };
}
