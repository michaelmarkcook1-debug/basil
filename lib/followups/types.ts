/**
 * lib/followups/types.ts
 *
 * "Awaiting your reply" — a thread (Gmail) or DM (Slack) where the last message
 * is inbound (from someone else), older than the stale threshold, with no
 * outbound from the user since. This is net-new detection (no prior engine).
 */

export interface PendingFollowup {
  /** Stable id: `gmail:<messageId>` or `slack:<channelId>`. */
  id: string;
  source: "gmail" | "slack";
  /** Display name of the person awaiting your reply. */
  fromName: string;
  /** Gmail: sender address. Slack: undefined (a DM has no email). */
  fromEmail?: string;
  /** Subject line (Gmail) or DM label (Slack). */
  subject: string;
  /** Last inbound message snippet, trimmed to ~140 chars. */
  preview: string;
  /** ISO8601 of the last inbound message. */
  lastInboundAt: string;
  /** Whole hours since lastInboundAt — for "8h waiting" display + ranking. */
  hoursWaiting: number;
  /** Deep link to the thread/DM (Gmail web; Slack falls back to Ask Basil). */
  href: string;
}

export interface DetectFollowupsResult {
  items: PendingFollowup[];
  /** Whether each source was actually reachable (connected) for this user. */
  sources: { gmail: boolean; slack: boolean };
}
