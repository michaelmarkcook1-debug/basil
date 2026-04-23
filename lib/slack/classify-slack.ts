/**
 * Slack conversation intelligence classifier.
 *
 * Evaluates a Slack thread transcript for:
 * - action items (assigned or identified)
 * - decisions (reached or needed)
 * - blockers / risks
 * - urgency / escalation
 * - relationship / contact signals
 * - meeting / scheduling signals
 *
 * Design:
 * - Thread-first: consumes full thread transcript, not a 300-char snippet
 * - Conservative extraction: only what is explicitly stated
 * - Never throws: returns low-confidence "noise" result on any failure
 * - Input capped at 6 000 chars (enforced by formatThreadTranscript)
 */

import { generateText } from "ai";
import { getSystemPrompt } from "@/lib/ai/system-prompt";

// ── Category types ─────────────────────────────────────────────────────────────

export type SlackSignalCategory =
  | "action_assigned"     // Explicit task assigned to / directly requested of Michael
  | "action_identified"   // Action item mentioned — may not be assigned to Michael
  | "decision_made"       // A decision was confirmed/reached in this conversation
  | "decision_needed"     // A decision is being awaited or requested from the team
  | "blocker_raised"      // Something is blocked, stuck, or at risk
  | "escalation"          // Urgent issue, time-critical, or high-stakes problem
  | "relationship_signal" // Meaningful update about a person, account, or deal
  | "meeting_signal"      // Scheduling discussion, meeting prep, or post-meeting follow-up
  | "informational"       // Update / FYI with no action needed
  | "noise";              // Casual chat, acknowledgments, reactions, off-topic

export type SlackUrgency = "high" | "medium" | "low";

// ── Extracted subtypes ─────────────────────────────────────────────────────────

export interface SlackAction {
  text: string;
  owner?: string;
  dueDate?: string;
  /** Urgency of this specific action item. */
  priority?: "high" | "medium" | "low";
}

export interface SlackDecision {
  text: string;
  /** Short (≤8 word) scannable headline. */
  title?: string;
  decidedBy?: string;
  /** Why this decision was made — only if explicitly stated. */
  rationale?: string;
  /** Alternatives explicitly mentioned as considered. */
  alternatives?: string[];
  /** Direct follow-up commitments explicitly tied to this decision. */
  consequences?: string[];
}

export interface SlackPerson {
  name: string;
  role?: string;
}

// ── Intelligence output ────────────────────────────────────────────────────────

export interface SlackIntelligence {
  category: SlackSignalCategory;
  /** 0–1 confidence in the category and extracted items. */
  confidence: number;
  urgency: SlackUrgency;
  /**
   * True when Michael is specifically addressed or named as the
   * owner/requester of an action or decision.
   */
  isMichaelAddressed: boolean;
  /** Explicit action items — only what is clearly stated. */
  actions: SlackAction[];
  /** Explicit decisions that were reached/confirmed. */
  decisions: SlackDecision[];
  /** Things explicitly described as blocked, stuck, or at risk. */
  blockers: string[];
  /** People explicitly named in the conversation. */
  people: SlackPerson[];
  /** Business / account names explicitly mentioned. */
  companies: string[];
  /**
   * 1–2 sentence summary capturing what matters.
   * Empty string for "noise" and trivial messages.
   */
  keyContext: string;
}

// ── Threshold constants ────────────────────────────────────────────────────────

/**
 * Minimum confidence to attempt Slack materialization.
 * Items between this floor and ACTION_CONFIDENCE.AUTO (0.60) are materialized
 * with needsReview=true. Items below this floor are discarded.
 *
 * This matches SLACK_REVIEW_FLOOR from lib/trust/policy.
 */
export const MIN_SLACK_MATERIALIZE_CONFIDENCE = 0.35;

/** Categories whose outputs are written to stores above MIN_CONFIDENCE. */
export const SLACK_MATERIALIZE_CATEGORIES = new Set<SlackSignalCategory>([
  "action_assigned",
  "action_identified",
  "decision_made",
  "decision_needed",
  "blocker_raised",
  "escalation",
  "relationship_signal",
  "meeting_signal",
]);

// ── Helpers ────────────────────────────────────────────────────────────────────

const VALID_CATEGORIES: SlackSignalCategory[] = [
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
];

function emptyIntelligence(): SlackIntelligence {
  return {
    category: "noise",
    confidence: 0,
    urgency: "low",
    isMichaelAddressed: false,
    actions: [],
    decisions: [],
    blockers: [],
    people: [],
    companies: [],
    keyContext: "",
  };
}

function parseIntelligence(raw: string): SlackIntelligence {
  // Strip markdown fences, then find the outermost JSON object.
  // Handles models that prepend explanation text despite explicit instructions —
  // without this, JSON.parse throws, the catch returns emptyIntelligence()
  // (noise/confidence=0), and nothing is ever materialized from the message.
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*\n?/, "")
    .replace(/\n?```\s*$/, "");

  const jsonStart = stripped.indexOf("{");
  const jsonEnd = stripped.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
    throw new Error("No JSON object found in classification response");
  }

  const parsed = JSON.parse(stripped.slice(jsonStart, jsonEnd + 1)) as Partial<SlackIntelligence>;

  const category: SlackSignalCategory = VALID_CATEGORIES.includes(
    parsed.category as SlackSignalCategory
  )
    ? (parsed.category as SlackSignalCategory)
    : "noise";

  const urgency: SlackUrgency = ["high", "medium", "low"].includes(parsed.urgency as string)
    ? (parsed.urgency as SlackUrgency)
    : "low";

  return {
    category,
    confidence:
      typeof parsed.confidence === "number"
        ? Math.min(1, Math.max(0, parsed.confidence))
        : 0.5,
    urgency,
    isMichaelAddressed: !!parsed.isMichaelAddressed,
    actions: Array.isArray(parsed.actions)
      ? parsed.actions
          .filter((a) => a?.text)
          .map((a) => ({
            text: a.text as string,
            owner: typeof a.owner === "string" ? a.owner : undefined,
            dueDate: typeof a.dueDate === "string" ? a.dueDate : undefined,
            priority: (["high", "medium", "low"] as string[]).includes(a.priority as string)
              ? (a.priority as "high" | "medium" | "low")
              : undefined,
          }))
      : [],
    decisions: Array.isArray(parsed.decisions)
      ? parsed.decisions
          .filter((d) => d?.text)
          .map((d) => ({
            text: d.text as string,
            title: typeof d.title === "string" ? d.title : undefined,
            decidedBy: typeof d.decidedBy === "string" ? d.decidedBy : undefined,
            rationale: typeof d.rationale === "string" ? d.rationale : undefined,
            alternatives: Array.isArray(d.alternatives) ? d.alternatives.filter(Boolean) : undefined,
            consequences: Array.isArray(d.consequences) ? d.consequences.filter(Boolean) : undefined,
          }))
      : [],
    blockers: Array.isArray(parsed.blockers) ? parsed.blockers.filter(Boolean) : [],
    people: Array.isArray(parsed.people) ? parsed.people.filter((p) => p?.name) : [],
    companies: Array.isArray(parsed.companies) ? parsed.companies.filter(Boolean) : [],
    keyContext: typeof parsed.keyContext === "string" ? parsed.keyContext.trim() : "",
  };
}

// ── Core classification function ───────────────────────────────────────────────

export interface ClassifySlackInput {
  /** Display name of the channel (e.g. "#eng-team", "DM: Ed Baum"). */
  channelName: string;
  /**
   * Full conversation transcript from formatThreadTranscript().
   * Already capped to 6 000 chars by the caller.
   */
  transcript: string;
  /** Whether this is a direct message to Michael. */
  isDM: boolean;
  /** Whether Michael was @-mentioned in the conversation. */
  isMention: boolean;
  /** ISO timestamp of the triggering message. */
  date: string;
}

/**
 * Classify a Slack conversation and extract structured intelligence.
 *
 * @param input  Channel metadata + full thread transcript.
 * @returns Structured SlackIntelligence. Never throws.
 */
export async function classifySlack(
  input: ClassifySlackInput
): Promise<SlackIntelligence> {
  const { channelName, transcript, isDM, isMention, date } = input;

  if (!transcript.trim()) return emptyIntelligence();

  const contextHints = [
    isDM && "This is a direct message to Michael.",
    isMention && "Michael was @-mentioned in this conversation.",
  ]
    .filter(Boolean)
    .join(" ");

  const prompt = `Analyze this Slack conversation and extract structured business intelligence. \
The primary reader is Michael Cook, a business executive.

${contextHints ? `Context: ${contextHints}\n` : ""}DATE: ${date}
CONVERSATION:
${transcript}

Classification rules — follow strictly:

1. category — choose exactly one:
   - action_assigned: explicit task assigned to or directly requested of Michael
   - action_identified: action item mentioned in the conversation (may not be Michael's)
   - decision_made: a decision was confirmed/reached in this conversation
   - decision_needed: a decision is being awaited or requested from the team
   - blocker_raised: something is explicitly blocked, stuck, or at risk
   - escalation: urgent issue, time-critical problem, or high-stakes escalation
   - relationship_signal: meaningful update about a person, account, deal, or partnership
   - meeting_signal: scheduling discussion, meeting prep needed, or post-meeting follow-up
   - informational: update or FYI with no response or action needed
   - noise: casual chat, acknowledgments, emoji reactions, off-topic, social

2. confidence: 0.3 if ambiguous/conversational, 0.7 if clear signals, 0.9+ if explicit

3. urgency:
   - high: needs attention today, time-critical, escalation language, words like "urgent/ASAP/blocking"
   - medium: should be addressed this week
   - low: informational, no time pressure

4. isMichaelAddressed: true ONLY if Michael is specifically named or @-mentioned as owner of an action/decision

5. actions: only explicit next steps or assigned tasks — not wishes or vague suggestions.
   Each action: text (required), owner (omit if unclear), dueDate (omit if none), priority ("high"/"medium"/"low" — high if urgent/blocking/time-critical)

6. decisions: only explicitly confirmed/announced decisions — not proposals, discussions, or "we could"
   - text: full decision as a sentence
   - title: short (≤8 word) scannable headline — omit key if you can't form one cleanly
   - decidedBy: who confirmed it, only if named — omit key otherwise
   - rationale: explicit reason given — omit key if not stated
   - alternatives: options explicitly mentioned as rejected — omit key if none
   - consequences: direct follow-ups explicitly tied to this decision — omit key if none

7. blockers: things explicitly described as blocked, stuck, broken, or at risk

8. people: only people explicitly named in the conversation

9. companies: business or account names explicitly mentioned

10. keyContext: 1–2 sentences on what matters for a briefing, or "" if noise/trivial

Extract ONLY what is explicitly stated. Never infer or fabricate.

Respond with ONLY valid JSON — no markdown fences, no explanation:
{
  "category": "action_assigned",
  "confidence": 0.85,
  "urgency": "high",
  "isMichaelAddressed": true,
  "actions": [{"text": "string", "owner": "optional string", "dueDate": "optional string", "priority": "high|medium|low"}],
  "decisions": [{"text": "string", "title": "string or omit", "decidedBy": "string or omit", "rationale": "string or omit", "alternatives": ["string"] or omit, "consequences": ["string"] or omit}],
  "blockers": ["string"],
  "people": [{"name": "string", "role": "optional string"}],
  "companies": ["string"],
  "keyContext": "1-2 sentences or empty string"
}`;

  try {
    const system = await getSystemPrompt();
    const { text } = await generateText({
      model: "anthropic/claude-sonnet-4.6",
      system,
      messages: [{ role: "user", content: prompt }],
      providerOptions: {
        gateway: { tags: ["feature:slack-classify", "env:production"] },
      },
    });

    return parseIntelligence(text);
  } catch (err) {
    console.error(
      "[slack-classify] classification failed:",
      err instanceof Error ? err.message : err
    );
    return emptyIntelligence();
  }
}

// ── Decision helpers ───────────────────────────────────────────────────────────

/**
 * Returns true if the intelligence result should trigger store materialization.
 */
export function shouldMaterializeSlack(intel: SlackIntelligence): boolean {
  if (intel.category === "noise") return false;
  if (intel.confidence < MIN_SLACK_MATERIALIZE_CONFIDENCE) return false;
  if (SLACK_MATERIALIZE_CATEGORIES.has(intel.category)) return true;

  // informational: only materialize when confident AND has named entities worth storing
  if (intel.category === "informational") {
    return (
      intel.confidence >= 0.8 &&
      (intel.people.length > 0 || intel.companies.length > 0) &&
      intel.keyContext.length > 0
    );
  }

  return false;
}

/**
 * Returns true if this Slack event is worth sending through the AI classifier.
 *
 * Gate prevents classifying every channel message — only high-signal candidates:
 * - DMs and Group DMs (always high signal)
 * - @-mentions (explicitly addressed to Michael)
 * - Messages already tagged with action/decision/escalation keywords
 */
export function shouldClassifySlack(opts: {
  isDM: boolean;
  isGroupDM: boolean;
  isMention: boolean;
  /** True when the message sender is a key person (Malcolm, Ed, Isaac, Olivia, Sam Jordan). */
  isFromKeyPerson?: boolean;
  tags: string[];
}): boolean {
  if (opts.isDM || opts.isGroupDM || opts.isMention || opts.isFromKeyPerson) return true;

  // Only classify channel messages when the rule engine already flagged signal
  const classifyTags = new Set(["action", "decision", "money", "legal", "hiring"]);
  return opts.tags.some((t) => classifyTags.has(t));
}
