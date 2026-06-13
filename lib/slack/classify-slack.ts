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

import { generateTextSafe } from "@/lib/ai/generate";
import { getTextModel, MAX_TOKENS } from "@/lib/ai/model-config";
import { getSystemPrompt } from "@/lib/ai/system-prompt";
import { parseAndValidate } from "@/lib/ai/parse-json";
import { SlackIntelligenceSchema } from "@/lib/ai/schemas";
import { getFlags } from "@/core/feature-flags";
import { getSettings } from "@/lib/settings/store";

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

export interface ToneShift {
  /** Name of the person whose tone shifted. */
  person: string;
  /** Direction relative to typical communication with this person. */
  direction: "warming" | "cooling" | "neutral";
  /** 1-sentence description of the observed shift. */
  summary: string;
}

export interface SlackAction {
  text: string;
  owner?: string;
  dueDate?: string;
  /** ISO timestamp when this action automatically expires (time-relative messages only). */
  expiresAt?: string;
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
   * True when the user is specifically addressed or named as the
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
  /**
   * Detected tone/attitude shifts. Only set for relationship_signal messages
   * where a notable change in warmth, engagement, or disposition is clearly
   * observable from the message language. Omit for routine communication.
   */
  toneShifts?: ToneShift[];
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
  const result = parseAndValidate(raw, SlackIntelligenceSchema, "[classify-slack]");
  if (result.ok) return result.data as SlackIntelligence;
  throw new Error(result.error);
}

// ── Core classification function ───────────────────────────────────────────────

export interface ClassifySlackInput {
  /** Username to scope the system prompt to. Required — no fallback. */
  username: string;
  /** Display name of the channel (e.g. "#eng-team", "DM: Sam Rivera"). */
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
  const { transcript, isDM, isMention, date, username } = input;

  if (!username) {
    console.error("[slack-classify] username is required — refusing to classify without owner");
    return emptyIntelligence();
  }
  const userName = (await getSettings(username).catch((err) => { console.error("[slack-classify] settings load failed:", err); return null; }))?.name ?? username;
  const userFirstName = userName.split(" ")[0];

  if (!transcript.trim()) return emptyIntelligence();

  const contextHints = [
    isDM && `This is a direct message conversation involving ${userFirstName}.`,
    isMention && `${userFirstName} was @-mentioned in this conversation.`,
    `Lines prefixed [You] are messages ${userFirstName} themselves sent. Lines with other names are messages they received.`,
    isDM && `In a DM, if the last message is prefixed [You], ${userFirstName} has already replied and likely does not need to reply again.`,
  ]
    .filter(Boolean)
    .join(" ");

  const prompt = `Analyze this Slack conversation and extract structured business intelligence. \
The primary reader is ${userName}, a business executive.
IMPORTANT: Lines prefixed "[You]:" in the transcript are messages ${userFirstName} sent. All other lines are messages they received from others.

${contextHints ? `Context: ${contextHints}\n` : ""}DATE: ${date}
CONVERSATION:
${transcript}

Classification rules — follow strictly:

1. category — choose exactly one:
   - action_assigned: explicit task assigned to or directly requested of ${userFirstName}
   - action_identified: action item mentioned in the conversation (may not be ${userFirstName}'s)
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

4. isMichaelAddressed: true ONLY if another person (not ${userFirstName}) specifically names or @-mentions ${userFirstName} as the owner/requester of an action or decision. Do NOT set true just because [You] lines appear — that just means ${userFirstName} participated.

5. actions: only explicit next steps or assigned tasks — not wishes or vague suggestions.
   Each action: text (required), owner (omit if unclear), dueDate (omit if none), priority ("high"/"medium"/"low" — high if urgent/blocking/time-critical)
   expiresAt: ISO timestamp when this action becomes irrelevant. ONLY set when the message contains time-relative language tied to a moment that will pass — e.g. "before the standup in 10 minutes", "before the meeting", "by EOD today", "in the next hour", "before the 3pm call". Compute relative to DATE (${date}). Examples: "standup in 10 mins" → DATE + 10 min; "before 3pm" → DATEdate at T15:00:00Z; "by EOD" → DATEdate at T23:59:00Z. Omit for anything without a clear expiry moment.

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

11. toneShifts: ONLY for relationship_signal messages. Omit entirely for other categories.
    Detect a shift when someone's language reveals a notable change in warmth, engagement,
    or disposition compared to what would be expected in normal professional Slack communication.
    Signals of WARMING: unusually enthusiastic, warm, grateful, complimentary, sharing personal
    detail, going out of their way to help, much more positive than a typical Slack message.
    Signals of COOLING: notably terse, curt, one-word replies where paragraphs are usual, formal
    language where casual was the norm, frustration, sarcasm, noticeably fewer words than typical.
    DO NOT flag routine Slack messages as a tone shift. Only flag when the language clearly
    departs from normal professional norms in one direction or the other.
    Each entry: person (name of the person), direction ("warming"/"cooling"/"neutral"), summary (1 sentence).

Extract ONLY what is explicitly stated. Never infer or fabricate.

Respond with ONLY valid JSON — no markdown fences, no explanation:
{
  "category": "action_assigned",
  "confidence": 0.85,
  "urgency": "high",
  "isMichaelAddressed": true,
  "actions": [{"text": "string", "owner": "optional string", "dueDate": "optional string", "priority": "high|medium|low", "expiresAt": "ISO timestamp or omit"}],
  "decisions": [{"text": "string", "title": "string or omit", "decidedBy": "string or omit", "rationale": "string or omit", "alternatives": ["string"] or omit, "consequences": ["string"] or omit}],
  "blockers": ["string"],
  "people": [{"name": "string", "role": "optional string"}],
  "companies": ["string"],
  "keyContext": "1-2 sentences or empty string",
  "toneShifts": [{"person": "string", "direction": "warming|cooling|neutral", "summary": "string"}] or omit
}`;

  // Read flags outside the try block — failure to fetch flags must not block classification
  const flags = await getFlags(username).catch((err) => { console.error("[slack-classify] flags load failed:", err); return null; });

  // ── dispatch_active: dispatcher is the authoritative AI call path (Week 7) ──
  if (flags && flags.dispatch_active) {
    try {
      const { buildIntelligenceContext } = await import("@/core/context/intelligence-context-builder");
      const { serializeContext } = await import("@/core/primitives/intelligence-context");
      const { dispatch } = await import("@/core/dispatch/dispatcher");

      const system = await getSystemPrompt(username);
      const ctx = await buildIntelligenceContext({ username, currentSignal: null, flags });
      const ctxText = serializeContext(ctx);
      const enrichedSystem = ctxText
        ? `${system}\n\n## Intelligence Context\n${ctxText}`
        : system;

      const { output } = await dispatch({
        username,
        intent: "classify_slack",
        sourceRef: null,
        modelKind: "fast",
        system: enrichedSystem,
        prompt,
        schema: SlackIntelligenceSchema,
        schemaName: "SlackIntelligence",
        schemaDescription: "Structured intelligence extracted from a Slack conversation",
        meter: { username, feature: "classify:slack" },
      });

      return output as SlackIntelligence;
    } catch (err) {
      console.error(
        "[slack-classify] dispatch_active failed, falling back to generateText:",
        err instanceof Error ? err.message : err
      );
    }
  }

  // ── Legacy path: generateText + optional dispatch_shadow trace ────────────
  try {
    const system = await getSystemPrompt(username);
    const { text } = await generateTextSafe({
      model: getTextModel("fast"),
      maxOutputTokens: MAX_TOKENS.fast,
      system,
      messages: [{ role: "user", content: prompt }],
    }, "fast", { username, feature: "classify:slack" });

    const result = parseIntelligence(text);

    // dispatch_shadow: parallel trace — only when dispatch is not already primary
    if (flags?.dispatch_shadow && !(flags?.dispatch_active)) {
      void (async () => {
        try {
          const { dispatch } = await import("@/core/dispatch/dispatcher");
          await dispatch({
            username,
            intent: "classify_slack",
            sourceRef: null,
            modelKind: "fast",
            system,
            prompt,
            schema: SlackIntelligenceSchema,
            schemaName: "SlackIntelligence",
            schemaDescription: "Structured intelligence extracted from a Slack conversation",
            meter: { username, feature: "classify:slack:shadow" },
          });
        } catch {
          // Shadow failures are intentionally silent — never surface to caller
        }
      })();
    }

    return result;
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
  /** True when the user is a member of the source channel (or it's a DM/Group DM). */
  isMember?: boolean;
  /** True when the message sender is a known contact. */
  isFromKeyPerson?: boolean;
  tags: string[];
}): boolean {
  // Relevance gate: when we KNOW the user is not a member of the channel and is
  // not addressed in it (no DM/Group DM/@-mention), never classify it. This
  // stops signals/actions/decisions surfacing from channels the user doesn't
  // participate in. Membership/mention are derived per-user from the Slack auth
  // identity upstream, so the rule holds for every deployment (no hardcoded user).
  if (opts.isMember === false && !opts.isDM && !opts.isGroupDM && !opts.isMention) {
    return false;
  }

  if (opts.isDM || opts.isGroupDM || opts.isMention || opts.isFromKeyPerson) return true;

  // Only classify channel messages when the rule engine already flagged signal
  const classifyTags = new Set(["action", "decision", "money", "legal", "hiring"]);
  return opts.tags.some((t) => classifyTags.has(t));
}
