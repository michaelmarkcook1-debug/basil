/**
 * Durable job queue — type definitions.
 *
 * Every background processing task is modelled as a typed Job so that:
 *  - Failed jobs can be retried automatically (via QStash in production)
 *  - Webhook retries are idempotent (each job carries a stable idempotency key)
 *  - Job status is visible in the system health panel
 *
 * Job lifecycle:
 *   queued → running → succeeded
 *                   ↘ failed → (retry) → running …
 *                           → (max retries) → dead
 */

// ── Job type literals ─────────────────────────────────────────────────────────

export type JobType =
  | "ingest.gmail"         // Process a single Gmail message (regular or Zoom)
  | "ingest.slack"         // Classify + materialize a Slack message/thread
  | "ingest.zoom"          // Process a Zoom meeting (direct API, not email)
  | "ingest.calendar"      // Process a Google/Outlook calendar event
  | "ingest.microsoft.mail"     // Process an Outlook email
  | "ingest.microsoft.calendar" // Process a Teams meeting/calendar event
  | "ingest.teams"         // Classify + materialize a Teams message/thread
  | "classify.action"      // Re-classify a single action item
  | "classify.decision"    // Re-classify a single decision item
  | "classify.memory"      // Re-classify a single memory item
  | "generate.briefing"    // Generate a daily briefing
  | "generate.digest"      // Generate a weekly digest
  | "generate.meetingPrep" // Generate meeting preparation notes
  | "import.whatsapp"      // Import a WhatsApp conversation chunk
  | "sync.aiProjects";     // Sync AI project state from Linear/GitHub

// ── Job status ────────────────────────────────────────────────────────────────

export type JobStatus =
  | "queued"    // accepted by queue, not yet delivered to handler
  | "running"   // handler is actively processing
  | "succeeded" // completed without error
  | "failed"    // last attempt failed; will be retried if attempts remain
  | "dead";     // exhausted all retries — needs manual intervention

// ── Job record ────────────────────────────────────────────────────────────────

export interface JobRecord {
  /** Stable ID — doubles as Workflow deduplication key. */
  id: string;
  type: JobType;
  username: string;
  /**
   * Originating provider: "gmail" | "outlook" | "slack" | "teams" | "zoom" | "system" | etc.
   * Populated where applicable to make the health panel more actionable.
   */
  provider?: string;
  /**
   * SHA-256 of the job's key inputs.  Used to skip duplicate AI work when the
   * same external item is re-delivered (e.g. webhook retry, poll-ingest overlap).
   */
  inputHash?: string;
  status: JobStatus;
  /** Number of execution attempts so far (incremented on each handler invocation). */
  attempts: number;
  /** Error message from the last failed attempt. */
  lastError?: string;
  /** ISO timestamp when this job was first created. */
  createdAt: string;
  /** ISO timestamp when the last handler invocation started. */
  updatedAt?: string;
  /** ISO timestamp when the job reached a terminal state (succeeded/dead). */
  finishedAt?: string;
}

// ── Typed payloads per job type ───────────────────────────────────────────────

export interface IngestGmailPayload {
  gmailId: string;
  externalId: string;
  eventId: string;
  subject: string;
  from: string;
  isZoom: boolean;
  snippetFallback?: string;
  dateFallback?: string;
}

export interface IngestSlackPayload {
  channelId: string;
  messageTs: string;
  externalId: string;
  eventId: string;
  channelName: string;
  from: string;
  date: string;
  isDM: boolean;
  isGroupDM: boolean;
  isMention: boolean;
  /** Raw message text fallback if thread fetch fails. */
  bodyFallback?: string;
}

export interface IngestZoomPayload {
  meetingId: string;
  externalId: string;
  eventId: string;
}

export interface IngestCalendarPayload {
  calendarId: string;
  eventId: string;
  externalId: string;
  provider: "google" | "microsoft";
}

export interface IngestMicrosoftMailPayload {
  messageId: string;
  externalId: string;
  eventId: string;
  subject: string;
  from: string;
  snippetFallback?: string;
}

export interface IngestMicrosoftCalendarPayload {
  eventId: string;
  externalId: string;
}

export interface IngestTeamsPayload {
  chatOrChannelId: string;
  channelId: string | null;
  messageId: string;
  externalId: string;
  eventId: string;
  channelName: string;
  from: string;
  date: string;
  isDM: boolean;
  isMention: boolean;
  bodyFallback?: string;
}

export interface GenerateBriefingPayload {
  date: string; // YYYY-MM-DD
}

export interface GenerateDigestPayload {
  /** ISO week start date (Monday), YYYY-MM-DD. */
  weekStart: string;
  /** Optional override for the end date; defaults to weekStart + 6 days. */
  weekEnd?: string;
}

export interface GenerateMeetingPrepPayload {
  calendarEventId: string;
  eventTitle: string;
}

export interface ImportWhatsappPayload {
  /** Raw conversation text chunk. */
  text: string;
  /** Display name or phone of the conversation partner. */
  contact: string;
}

export interface SyncAiProjectsPayload {
  /** Whether to do a full resync or incremental. */
  full?: boolean;
}

/** Union of all typed payloads, keyed by job type. */
export interface JobPayloadMap {
  "ingest.gmail": IngestGmailPayload;
  "ingest.slack": IngestSlackPayload;
  "ingest.zoom": IngestZoomPayload;
  "ingest.calendar": IngestCalendarPayload;
  "ingest.microsoft.mail": IngestMicrosoftMailPayload;
  "ingest.microsoft.calendar": IngestMicrosoftCalendarPayload;
  "ingest.teams": IngestTeamsPayload;
  "classify.action": { actionId: string };
  "classify.decision": { decisionId: string };
  "classify.memory": { memoryId: string };
  "generate.briefing": GenerateBriefingPayload;
  "generate.digest": GenerateDigestPayload;
  "generate.meetingPrep": GenerateMeetingPrepPayload;
  "import.whatsapp": ImportWhatsappPayload;
  "sync.aiProjects": SyncAiProjectsPayload;
}

/** A queued job with its typed payload. */
export interface Job<T extends JobType = JobType> extends JobRecord {
  payload: JobPayloadMap[T];
}
