/**
 * Proactive email intelligence classifier.
 *
 * Takes a plain-text email body + envelope metadata and produces structured
 * intelligence: category, confidence, extracted actions/decisions/people.
 *
 * Design:
 * - AI-powered with conservative extraction (explicit content only)
 * - Never fabricates — returns empty arrays rather than invented items
 * - Never throws — returns a low-confidence result on any failure
 * - Body clipped to 4 000 chars to keep AI costs bounded
 */

import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { getSystemPrompt } from "@/lib/ai/system-prompt";

// ── Category types ─────────────────────────────────────────────────────────────

export type EmailCategory =
  | "action_required"     // Sender is explicitly asking Michael to do something
  | "decision_request"    // Sender is asking Michael to make a decision or give approval
  | "decision_made"       // Email announces/confirms a decision that was reached
  | "follow_up_needed"    // Thread that Michael should actively follow up on
  | "relationship_signal" // Significant update about a contact, account, or business relationship
  | "scheduling_signal"   // Meeting request, availability question, calendar coordination
  | "informational_only"  // FYI update with no response or action needed
  | "low_value_noise";    // Newsletter, auto-notification, marketing, noreply, OOO, spam

export type EmailUrgency = "high" | "medium" | "low";

// ── Extracted types ────────────────────────────────────────────────────────────

export interface EmailPerson {
  name: string;
  role?: string;
}

export interface EmailAction {
  text: string;
  dueDate?: string;
  /** Urgency of this specific action item. */
  priority?: "high" | "medium" | "low";
}

export interface EmailDecision {
  text: string;
  /** Short (≤8 word) scannable headline. */
  title?: string;
  decidedBy?: string;
  /** Why this decision was made — only if explicitly stated. */
  rationale?: string;
  /** Alternatives explicitly mentioned as considered. */
  alternatives?: string[];
  /** Direct follow-up commitments tied to this decision. */
  consequences?: string[];
}

// ── Intelligence output ────────────────────────────────────────────────────────

export interface EmailIntelligence {
  category: EmailCategory;
  /** 0–1 — confidence in the category and extracted items. */
  confidence: number;
  urgency: EmailUrgency;
  /** Explicit action items addressable to Michael. */
  actions: EmailAction[];
  /** Explicit decisions reported in the email. */
  decisions: EmailDecision[];
  /** People explicitly mentioned with roles if determinable. */
  people: EmailPerson[];
  /** Company or account names mentioned. */
  companies: string[];
  /** Explicit deadlines, e.g. "EOD Friday", "1 Dec 2024". */
  deadlines: string[];
  /** Risks, blockers, or concerns explicitly raised. */
  blockers: string[];
  /**
   * 1–2 sentence context summary suitable for storage in memory.
   * Empty string if the email is too sparse or low-value.
   */
  keyContext: string;
}

// ── Threshold constants ────────────────────────────────────────────────────────

/**
 * Minimum confidence to attempt email materialization.
 * Items between this floor and ACTION_CONFIDENCE.AUTO (0.60) are materialized
 * with needsReview=true. Items below this floor are discarded.
 *
 * This matches EMAIL_REVIEW_FLOOR from lib/trust/policy.
 */
export const MIN_MATERIALIZE_CONFIDENCE = 0.35;

/**
 * Categories whose outputs are written to stores when confidence meets the
 * minimum threshold.  `informational_only` is only materialized at >=0.8
 * and only if there are people/companies that give it relationship standing.
 * `low_value_noise` is never materialized.
 */
export const MATERIALIZE_CATEGORIES = new Set<EmailCategory>([
  "action_required",
  "decision_request",
  "decision_made",
  "follow_up_needed",
  "relationship_signal",
  "scheduling_signal",
]);

// ── Helpers ────────────────────────────────────────────────────────────────────

const VALID_CATEGORIES: EmailCategory[] = [
  "action_required",
  "decision_request",
  "decision_made",
  "follow_up_needed",
  "relationship_signal",
  "scheduling_signal",
  "informational_only",
  "low_value_noise",
];

function emptyIntelligence(): EmailIntelligence {
  return {
    category: "low_value_noise",
    confidence: 0,
    urgency: "low",
    actions: [],
    decisions: [],
    people: [],
    companies: [],
    deadlines: [],
    blockers: [],
    keyContext: "",
  };
}

function parseIntelligence(raw: string): EmailIntelligence {
  // Strip markdown fences, then find the outermost JSON object.
  // This handles models that prepend explanation text before the JSON
  // (e.g. "Here is the result:") despite being told not to — without this
  // guard JSON.parse throws, the catch returns emptyIntelligence(), and
  // the email is silently classified as low_value_noise with confidence=0.
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*\n?/, "")
    .replace(/\n?```\s*$/, "");

  const jsonStart = stripped.indexOf("{");
  const jsonEnd = stripped.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
    throw new Error("No JSON object found in classification response");
  }

  const parsed = JSON.parse(stripped.slice(jsonStart, jsonEnd + 1)) as Partial<EmailIntelligence>;

  const category: EmailCategory = VALID_CATEGORIES.includes(parsed.category as EmailCategory)
    ? (parsed.category as EmailCategory)
    : "low_value_noise";

  const urgency: EmailUrgency = ["high", "medium", "low"].includes(parsed.urgency as string)
    ? (parsed.urgency as EmailUrgency)
    : "low";

  return {
    category,
    confidence:
      typeof parsed.confidence === "number"
        ? Math.min(1, Math.max(0, parsed.confidence))
        : 0.5,
    urgency,
    actions: Array.isArray(parsed.actions)
      ? parsed.actions
          .filter((a) => a?.text)
          .map((a) => ({
            text: a.text as string,
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
    people: Array.isArray(parsed.people) ? parsed.people.filter((p) => p?.name) : [],
    companies: Array.isArray(parsed.companies) ? parsed.companies.filter(Boolean) : [],
    deadlines: Array.isArray(parsed.deadlines) ? parsed.deadlines.filter(Boolean) : [],
    blockers: Array.isArray(parsed.blockers) ? parsed.blockers.filter(Boolean) : [],
    keyContext: typeof parsed.keyContext === "string" ? parsed.keyContext.trim() : "",
  };
}

// ── Core classification function ───────────────────────────────────────────────

export interface ClassifyEmailInput {
  /** Username to scope the system prompt to. Defaults to "michael". */
  username?: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  body: string;
}

/**
 * Classify an email and extract structured intelligence.
 *
 * @param input  Email envelope + plain-text body (HTML already stripped).
 * @returns Structured EmailIntelligence. Never throws.
 */
export async function classifyEmail(
  input: ClassifyEmailInput
): Promise<EmailIntelligence> {
  const { subject, from, date, snippet, body, username = "michael" } = input;

  // Clip to 4 000 chars — enough for rich emails, bounded AI cost
  const bodyClip = (body || snippet || "").trim().slice(0, 4_000);

  if (!bodyClip) return emptyIntelligence();

  const prompt = `Classify this email and extract structured intelligence. \
The recipient is Michael Cook, a business executive.

FROM: ${from}
SUBJECT: ${subject}
DATE: ${date}
BODY:
${bodyClip}

Classification rules — follow these strictly:

1. category — choose exactly one:
   - action_required: sender explicitly asks Michael to do something
   - decision_request: sender asks Michael to decide or give approval
   - decision_made: email announces/confirms a decision that was reached
   - follow_up_needed: thread Michael should actively follow up on
   - relationship_signal: significant update about a contact, account, or business relationship
   - scheduling_signal: meeting request, availability question, calendar coordination
   - informational_only: FYI update, no response or action needed
   - low_value_noise: newsletter, auto-notification, marketing, noreply, OOO, spam

2. confidence: 0.3 if sparse/ambiguous, 0.7 if clear signals, 0.9+ if explicit and detailed

3. urgency:
   - high: deadline within 24h, time-critical ask, escalation
   - medium: expected response within a few days
   - low: no urgency or purely informational

4. actions: only explicitly assigned or implied tasks for Michael — not vague suggestions.
   Each action: text (required), dueDate (omit if none), priority ("high"/"medium"/"low" — high if urgent/deadline-driven, low if no urgency)
5. decisions: for confirmed/announced decisions, extract:
   - text: the full decision as a sentence
   - title: short (≤8 word) scannable headline, only if you can form one cleanly — omit key otherwise
   - decidedBy: who confirmed it, only if named — omit key otherwise
   - rationale: the explicit reason given — omit key if not stated
   - alternatives: options explicitly named as rejected — omit key if none stated
   - consequences: direct follow-up commitments tied to this decision — omit key if none stated
6. people: only people explicitly named in the email body
7. companies: business or account names explicitly mentioned
8. deadlines: only explicit dates or timeframes mentioned
9. blockers: risks, problems, or concerns explicitly raised in the email
10. keyContext: 1–2 sentences capturing what matters, or "" if low_value_noise

Extract ONLY what is explicitly present. Never fabricate or infer.

Respond with ONLY valid JSON — no markdown fences, no explanation:
{
  "category": "action_required",
  "confidence": 0.85,
  "urgency": "medium",
  "actions": [{"text": "string", "dueDate": "string or omit", "priority": "high|medium|low"}],
  "decisions": [{"text": "string", "title": "string or omit", "decidedBy": "string or omit", "rationale": "string or omit", "alternatives": ["string"] or omit, "consequences": ["string"] or omit}],
  "people": [{"name": "string", "role": "string or omit"}],
  "companies": ["string"],
  "deadlines": ["string"],
  "blockers": ["string"],
  "keyContext": "1-2 sentences or empty string"
}`;

  try {
    const system = await getSystemPrompt(username);
    const { text } = await generateText({
      model: anthropic("claude-3-5-haiku-20241022"),
      system,
      messages: [{ role: "user", content: prompt }],
    });

    return parseIntelligence(text);
  } catch (err) {
    console.error(
      "[email-classify] classification failed:",
      err instanceof Error ? err.message : err
    );
    return emptyIntelligence();
  }
}

/**
 * Returns true if the intelligence result should trigger store materialization.
 * Low-value noise and low-confidence results are never materialized.
 */
export function shouldMaterialize(intel: EmailIntelligence): boolean {
  if (intel.category === "low_value_noise") return false;
  if (intel.confidence < MIN_MATERIALIZE_CONFIDENCE) return false;
  if (MATERIALIZE_CATEGORIES.has(intel.category)) return true;

  // informational_only: only when confident AND has named people/companies
  // that give it standing as a relationship signal worth storing.
  if (intel.category === "informational_only") {
    return (
      intel.confidence >= 0.8 &&
      (intel.people.length > 0 || intel.companies.length > 0) &&
      intel.keyContext.length > 0
    );
  }

  return false;
}
