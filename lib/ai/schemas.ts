/**
 * Zod schemas for every AI-generated output in Basil.
 *
 * Single source of truth for:
 *  - Output.object({ schema }) arguments in generateText() calls (API routes)
 *  - safeParse() validation in generateText() classifier paths
 *
 * Rules:
 *  - Schemas mirror the TypeScript interfaces in lib/types/ and lib/email/ etc.
 *  - Content fields use .nullable() — the AI may legitimately return null.
 *  - Enum fields are strict: invalid values cause validation failure + retry.
 *  - Arrays are always arrays (never null/undefined from AI output).
 */

import { z } from "zod";

// ── Shared sub-schemas ─────────────────────────────────────────────────────────

const prioritySchema = z.enum(["high", "medium", "low"]);
const confidenceSchema = z.number().min(0).max(1).catch(0.5);

/**
 * A single detected tone/attitude shift in a relationship_signal message.
 * Only present when the AI observes a notable change — not for routine messages.
 */
const ToneShiftSchema = z.object({
  /** Name of the person whose tone shifted (should match a known contact). */
  person: z.string(),
  /** Direction relative to what's typical for this relationship. */
  direction: z.enum(["warming", "cooling", "neutral"]),
  /** 1-sentence description of the observed shift. */
  summary: z.string(),
});

// ── Email Intelligence ─────────────────────────────────────────────────────────

export const EmailCategorySchema = z.enum([
  "action_required",
  "decision_request",
  "decision_made",
  "follow_up_needed",
  "relationship_signal",
  "scheduling_signal",
  "informational_only",
  "low_value_noise",
]);

const EmailActionSchema = z.object({
  text:      z.string(),
  dueDate:   z.string().optional(),
  priority:  prioritySchema.optional(),
  /** ISO timestamp when this action auto-expires — only for time-bounded actions. */
  expiresAt: z.string().optional(),
});

const EmailDecisionSchema = z.object({
  text:         z.string(),
  title:        z.string().optional(),
  decidedBy:    z.string().optional(),
  rationale:    z.string().optional(),
  alternatives: z.array(z.string()).optional(),
  consequences: z.array(z.string()).optional(),
});

const EmailPersonSchema = z.object({
  name: z.string(),
  role: z.string().optional(),
});

export const EmailIntelligenceSchema = z.object({
  category:   EmailCategorySchema.catch("low_value_noise"),
  confidence: confidenceSchema,
  urgency:    z.enum(["high", "medium", "low"]).catch("low"),
  actions:    z.array(EmailActionSchema).default([]),
  decisions:  z.array(EmailDecisionSchema).default([]),
  people:     z.array(EmailPersonSchema).default([]),
  companies:  z.array(z.string()).default([]),
  deadlines:  z.array(z.string()).default([]),
  blockers:   z.array(z.string()).default([]),
  keyContext: z.string().default(""),
  /**
   * Detected tone/attitude shifts — only present for relationship_signal
   * messages where a notable change in warmth, engagement, or disposition
   * is explicitly observable. Omit for routine professional communication.
   */
  toneShifts: z.array(ToneShiftSchema).optional(),
});

export type EmailIntelligenceOutput = z.infer<typeof EmailIntelligenceSchema>;

// ── Slack / Teams Intelligence ─────────────────────────────────────────────────

export const SlackSignalCategorySchema = z.enum([
  "action_assigned",
  "action_identified",
  "decision_made",
  "decision_needed",
  "blocker_raised",
  "escalation",
  "relationship_signal",
  "meeting_signal",
  "informational",
  "noise",
]);

const SlackActionSchema = z.object({
  text:      z.string(),
  owner:     z.string().optional(),
  dueDate:   z.string().optional(),
  priority:  prioritySchema.optional(),
  /** ISO timestamp when this action auto-expires — only for time-bounded actions. */
  expiresAt: z.string().optional(),
});

const SlackDecisionSchema = z.object({
  text:         z.string(),
  title:        z.string().optional(),
  decidedBy:    z.string().optional(),
  rationale:    z.string().optional(),
  alternatives: z.array(z.string()).optional(),
  consequences: z.array(z.string()).optional(),
});

const SlackPersonSchema = z.object({
  name: z.string(),
  role: z.string().optional(),
});

export const SlackIntelligenceSchema = z.object({
  category:           SlackSignalCategorySchema.catch("noise"),
  confidence:         confidenceSchema,
  urgency:            z.enum(["high", "medium", "low"]).catch("low"),
  isMichaelAddressed: z.boolean().default(false),
  actions:            z.array(SlackActionSchema).default([]),
  decisions:          z.array(SlackDecisionSchema).default([]),
  blockers:           z.array(z.string()).default([]),
  people:             z.array(SlackPersonSchema).default([]),
  companies:          z.array(z.string()).default([]),
  keyContext:         z.string().default(""),
  /**
   * Detected tone/attitude shifts — only for relationship_signal messages
   * where a notable change in warmth, engagement, or disposition is
   * explicitly observable. Omit for routine professional communication.
   */
  toneShifts:         z.array(ToneShiftSchema).optional(),
});

export type SlackIntelligenceOutput = z.infer<typeof SlackIntelligenceSchema>;

// ── Zoom Meeting Extract ───────────────────────────────────────────────────────

const ZoomActionItemSchema = z.object({
  text:       z.string(),
  owner:      z.string().optional(),
  dueDate:    z.string().optional(),
  confidence: confidenceSchema.optional(),
});

const ZoomDecisionSchema = z.object({
  text:         z.string(),
  title:        z.string().optional(),
  decidedBy:    z.string().optional(),
  rationale:    z.string().optional(),
  alternatives: z.array(z.string()).optional(),
  consequences: z.array(z.string()).optional(),
  confidence:   confidenceSchema.optional(),
});

export const ZoomMeetingExtractSchema = z.object({
  meetingTitle: z.string(),
  meetingDate:  z.string(),
  attendees:    z.array(z.string()).default([]),
  summary:      z.string().default(""),
  actionItems:  z.array(ZoomActionItemSchema).default([]),
  decisions:    z.array(ZoomDecisionSchema).default([]),
  blockers:     z.array(z.string()).default([]),
  followUps:    z.array(z.string()).default([]),
  /** Key topics and themes discussed — not decisions, not action items, just what was covered. */
  topics:       z.array(z.string()).default([]),
  confidence:   confidenceSchema,
});

export type ZoomMeetingExtractOutput = z.infer<typeof ZoomMeetingExtractSchema>;

// ── Zoom Process-Meeting Intelligence ─────────────────────────────────────────

export const MeetingIntelligenceSchema = z.object({
  actions: z.array(z.object({
    text:       z.string(),
    owner:      z.string().optional(),
    dueDate:    z.string().optional(),
    confidence: confidenceSchema,
  })).default([]),
  decisions: z.array(z.object({
    text:       z.string(),
    title:      z.string().optional(),
    decidedBy:  z.string().optional(),
    rationale:  z.string().optional(),
    confidence: confidenceSchema,
  })).default([]),
  summary:    z.string().default(""),
  keyTopics:  z.array(z.string()).default([]),
});

export type MeetingIntelligenceOutput = z.infer<typeof MeetingIntelligenceSchema>;

// ── Contact Profile ────────────────────────────────────────────────────────────

export const ContactProfileSchema = z.object({
  personality:      z.string(),
  whatMakesThemTick: z.string(),
  watchOut:         z.string(),
  recentActivity:   z.string(),
  activitySource:   z.string(),
  summary:          z.string().optional(),
  canonicalFields:  z.object({
    name:     z.string().optional(),
    title:    z.string().optional(),
    company:  z.string().optional(),
    location: z.string().optional(),
    email:    z.string().optional(),
    phone:    z.string().optional(),
  }).optional(),
});

export type ContactProfileOutput = z.infer<typeof ContactProfileSchema>;

// ── Briefing ───────────────────────────────────────────────────────────────────

/** AI-generated fields only — server adds generatedAt / extraContextSummary */
export const BriefingOutputSchema = z.object({
  criticalToday:       z.string().nullable().default(null),
  projectRadar:        z.string().nullable().default(null),
  followUps:           z.string().nullable().default(null),
  decisionsToWatch:    z.string().nullable().default(null),
  meetingsNeedingPrep: z.string().nullable().default(null),
  peopleAndAccounts:   z.string().nullable().default(null),
  inboxSlack:          z.string().nullable().default(null),
});

export type BriefingOutput = z.infer<typeof BriefingOutputSchema>;

// ── Digest ─────────────────────────────────────────────────────────────────────

/** AI-generated fields only — server adds generatedAt / weekStart / weekEnd / dataSources */
export const DigestOutputSchema = z.object({
  majorMeetings:       z.string().nullable().default(null),
  whatChanged:         z.string().nullable().default(null),
  decisionsLog:        z.string().nullable().default(null),
  blockers:            z.string().nullable().default(null),
  relationshipSignals: z.string().nullable().default(null),
  nextWeekNeeds:       z.string().nullable().default(null),
});

export type DigestOutput = z.infer<typeof DigestOutputSchema>;

// ── Meeting Prep ───────────────────────────────────────────────────────────────

export const MeetingPrepOutputSchema = z.object({
  fromTodaysCalls: z.array(z.object({
    title:   z.string(),
    summary: z.string(),
  })).default([]),
  attendeeInsights: z.array(z.object({
    name:  z.string(),
    role:  z.string(),
    style: z.string(),
  })).default([]),
  topicsToRaise: z.array(z.object({
    title:    z.string(),
    context:  z.string(),
    priority: z.string(),
  })).default([]),
  suggestedQuestions: z.array(z.string()).default([]),
  thingsToLand:       z.array(z.string()).default([]),
  watchOuts:          z.array(z.string()).default([]),
  unresolvedRisks: z.array(z.object({
    risk:        z.string(),
    source:      z.string(),
    raisedDate:  z.string().optional(),
  })).default([]),
});

export type MeetingPrepOutput = z.infer<typeof MeetingPrepOutputSchema>;

// ── Memory Import ──────────────────────────────────────────────────────────────

/** Must match MemoryKind in lib/memory/types.ts exactly. */
const MEMORY_KINDS = ["fact", "preference", "person", "context"] as const;

export const MemoryItemSchema = z.object({
  kind:    z.enum(MEMORY_KINDS).catch("fact" as const),
  content: z.string().min(1),
  entity:  z.string().optional(),
});

export const MemoryImportArraySchema = z.array(MemoryItemSchema);

export type MemoryItemOutput = z.infer<typeof MemoryItemSchema>;
