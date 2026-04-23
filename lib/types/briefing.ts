/**
 * Types for AI-generated briefing and weekly digest outputs.
 *
 * These were previously defined inline in their respective pages. They live
 * here so that the generate API routes and the dashboard pages share the same
 * contract and TypeScript catches any drift.
 */

// ── Daily Briefing ────────────────────────────────────────────────────────────

/**
 * Shape returned by POST /api/generate/briefing.
 *
 * v2 — intelligence-centric sections replacing the old source-centric shape
 * (calendar / emails / slack / tasks / decisions).
 *
 * Each section is free-form prose (paragraphs, bullets, numbered lists) or
 * null when Basil has no signal for that category today.
 */
export interface Briefing {
  /** Top 3-5 urgent items synthesized across all sources for today. */
  criticalToday:       string | null;
  /** Email replies needed, stalled actions requiring a nudge, outstanding decision follow-ups. */
  followUps:           string | null;
  /** Recent decisions with open consequences; new decisions implied by today's data. */
  decisionsToWatch:    string | null;
  /** Today's video/multi-attendee meetings with prep notes and signal gaps flagged. */
  meetingsNeedingPrep: string | null;
  /** Cross-source relationship signals — people/accounts showing up across email + calendar + Slack. */
  peopleAndAccounts:   string | null;
  /** Remaining inbox and Slack highlights not already surfaced above. */
  inboxSlack:          string | null;
  generatedAt: string;
  extraContextSummary?: string;
}

// ── Weekly Digest ─────────────────────────────────────────────────────────────

/**
 * Full weekly digest — unified executive summary.
 *
 * v3 — replaces the old two-column product-split shape (ag / aptg) with a
 * single, intelligence-centric view of the whole week: what happened, what
 * changed, what got decided, what's blocked, who mattered, what next week needs.
 *
 * Each section is free-form prose or null when Basil has no signal.
 */
export interface Digest {
  /** Key meetings, 1:1s, and calls from the past 7 days — who, what emerged. */
  majorMeetings:       string | null;
  /** Work that moved, shipped, or shifted this week — actions completed, momentum. */
  whatChanged:         string | null;
  /** Decisions logged or implied this week, with rationale and follow-on consequences. */
  decisionsLog:        string | null;
  /** Blockers, stalled threads, overdue items, and risks that remain unresolved. */
  blockers:            string | null;
  /** Cross-source relationship signals — people and accounts showing up across email, calendar, Slack. */
  relationshipSignals: string | null;
  /** What next week needs: prep items, open threads to close, momentum to carry forward. */
  nextWeekNeeds:       string | null;
  generatedAt: string;
  dataSources?: {
    calendarPast:       number;
    calendarUpcoming:   number;
    emails:             number;
    slackMessages:      number;
    zoomSummaries:      number;
    completedActions:   number;
    openActions:        number;
    recentDecisions:    number;
    memories:           number;
  };
}
