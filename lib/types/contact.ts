/**
 * Supplementary contact types — extends the core Contact interface
 * (lib/contacts-data.ts) with discovery and suggestion shapes.
 *
 * Import Contact itself from lib/contacts-data.ts; import these utility types
 * from here.
 */

// ── Contact discovery suggestion ─────────────────────────────────────────────

/**
 * A person Basil has observed in emails or Slack but who isn't yet in the
 * contact directory. Surfaced on the Contacts page so Michael can add them.
 *
 * Previously defined inline in app/dashboard/contacts/page.tsx.
 */
export interface ContactSuggestion {
  /** Stable dedup key — typically a normalised email address. */
  id: string;
  /** Human-readable name as seen in message headers or Slack display name. */
  displayName: string;
  /** Email address if available. */
  email?: string;
  /** Slack channel names this person was active in. */
  slackChannels: string[];
  /** Number of email threads observed. */
  emailCount: number;
  /** Number of Slack messages observed. */
  slackCount: number;
  /** ISO date of most recent observed activity. */
  lastSeen: string;
  /** Short excerpt from a representative message. */
  sample: string;
  /** Which integration surfaces produced signal ("email", "slack", etc.). */
  signalSources: string[];
}
