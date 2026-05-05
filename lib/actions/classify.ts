/**
 * Rule-based action classification.
 *
 * Assigns a category ("critical" | "admin" | "personal") and flags whether
 * the action implies a decision that needs to be made first.
 *
 * Design goals:
 *   - Zero latency — runs synchronously in createAction, no network calls.
 *   - LLM-ready — results can be overridden by a batch LLM enrichment pass.
 *   - Deterministic — same text always maps to the same category.
 *
 * Scoring:
 *   Each pattern set contributes positive weight.  The highest-scoring
 *   category wins; ties prefer critical > admin > personal.
 *   A minimum score of 1 must be reached — below that the action is left
 *   uncategorized (category = undefined) so the LLM pass can fill it in.
 */

import type { ActionCategory } from "@/lib/types/action";

// ── Critical patterns ──────────────────────────────────────────────────────────
// Strategic, project-critical, or high-stakes work items.

const CRITICAL_STRONG = [
  /\b(decision|decide|approve|approval|sign[- ]off)\b/i,
  /\b(hire|hiring|onboard|offer letter)\b/i,
  /\b(contract|agreement|deal|negotiate|negotiat)\b/i,
  /\b(budget|forecast|P&L|revenue|cost|spend|investment)\b/i,
  /\b(strategy|strategic|roadmap|OKR|goal|milestone)\b/i,
  /\b(launch|release|ship|deploy|go-live|go live)\b/i,
  /\b(architecture|technical design|tech spec|RFC|design doc)\b/i,
  /\b(pitch|proposal|RFP|tender|bid)\b/i,
  /\b(board|investor|fundrais|equity|cap table)\b/i,
  /\b(performance review|PIP|promotion)\b/i,
  /\b(legal|compliance|regulatory|GDPR|data protection)\b/i,
  /\b(PR\b|pull request|code review|merge)\b/i,
  /\b(incident|outage|production issue|critical bug|P0|P1)\b/i,
];

const CRITICAL_MODERATE = [
  /\b(project|deliverable|deadline|milestone|sprint|ticket)\b/i,
  /\b(stakeholder|client|customer|partner)\b/i,
  /\b(present|presentation|demo|review)\b/i,
  /\b(report|analysis|analytics|metrics|KPI)\b/i,
  /\b(team|engineer|developer|designer|product)\b/i,
  /\b(priority|urgent|important|critical)\b/i,
  /\b(plan|planning|implement|build|develop|create)\b/i,
];

// ── Admin patterns ─────────────────────────────────────────────────────────────
// Routine operational and logistical tasks.

const ADMIN_STRONG = [
  /\b(schedule|book|reschedule|cancel)\b.*\b(meeting|call|appointment|slot)\b/i,
  /\b(confirm|confirm.*attendance|RSVP|accept.*invite)\b/i,
  /\b(send.*email|reply.*email|email.*reply|respond.*email)\b/i,
  /\b(expense|receipt|invoice|reimburse|reimbursement)\b/i,
  /\b(calendar invite|calendar block|set up.*call|set up.*meeting)\b/i,
  /\b(remind.*about|follow[- ]up.*with|check[- ]in.*with)\b/i,
  /\b(add.*to.*calendar|put.*in.*calendar)\b/i,
];

const ADMIN_MODERATE = [
  /\b(schedule|book|arrange|organise|organize)\b/i,
  /\b(confirm|attendance|attending|join|meet)\b/i,
  /\b(reply|respond|send|forward|cc|copy)\b/i,
  /\b(follow[- ]up|check[- ]in|ping|slack|message)\b/i,
  /\b(document|write up|note|record|log)\b/i,
  /\b(update.*status|status update|weekly update|standup)\b/i,
  /\b(intro|introduction|connect.*with|set.*up.*intro)\b/i,
  /\b(access|permission|add.*to|remove.*from|invite)\b/i,
];

// ── Personal patterns ──────────────────────────────────────────────────────────
// Non-work personal tasks.

const PERSONAL_STRONG = [
  /\b(doctor|dentist|GP|physio|therapist|hospital|clinic|appointment)\b/i,
  /\b(gym|workout|exercise|run|yoga|pilates|fitness)\b/i,
  /\b(family|kids?|children|spouse|partner|parent|dad|mom|mum)\b/i,
  /\b(groceries|supermarket|shopping|errands)\b/i,
  /\b(birthday|anniversary|holiday|vacation|travel plan)\b/i,
  /\b(personal|private|home|house)\b/i,
  /\b(bank|mortgage|rent|landlord|utility|insurance|tax return)\b/i,
];

const PERSONAL_MODERATE = [
  /\b(lunch|dinner|brunch|coffee|social)\b/i,
  /\b(car|service|MOT|garage)\b/i,
  /\b(read|book|podcast|course|learn)\b/i,
];

// ── Decision-required patterns ─────────────────────────────────────────────────
// Actions that imply a choice or decision must be made before proceeding.

const DECISION_REQUIRED_PATTERNS = [
  /\b(decide|decision|choose|select|pick)\b/i,
  /\b(whether to|should (we|i|they)|either.{1,40}or)\b/i,
  /\b(option[s]?|alternative[s]?|trade.?off[s]?|pros.{1,10}cons)\b/i,
  /\b(evaluate|assess|consider|weigh up)\b/i,
  /\b(go with|go ahead|sign off|approve|greenlight)\b/i,
  /\b(confirm.*direction|align.*on)\b/i,
];

// ── Scorer ─────────────────────────────────────────────────────────────────────

function scorePatterns(text: string, strong: RegExp[], moderate: RegExp[]): number {
  let score = 0;
  for (const p of strong)   if (p.test(text)) score += 3;
  for (const p of moderate) if (p.test(text)) score += 1;
  return score;
}

export interface ClassifyResult {
  category?: ActionCategory;
  decisionRequired: boolean;
}

/**
 * Classify a single action text into a category and flag decision requirement.
 *
 * @param text      The full action text.
 * @param priority  Optional priority hint — "high" nudges toward critical.
 */
export function classifyAction(
  text: string,
  priority?: "high" | "medium" | "low"
): ClassifyResult {
  const decisionRequired = DECISION_REQUIRED_PATTERNS.some((p) => p.test(text));

  const criticalScore =
    scorePatterns(text, CRITICAL_STRONG, CRITICAL_MODERATE) +
    (priority === "high" ? 2 : 0);
  const adminScore    = scorePatterns(text, ADMIN_STRONG,    ADMIN_MODERATE);
  const personalScore = scorePatterns(text, PERSONAL_STRONG, PERSONAL_MODERATE);

  const maxScore = Math.max(criticalScore, adminScore, personalScore);

  // Require at least one strong-pattern match worth of signal (score ≥ 3)
  // or two moderate signals (score ≥ 2) to assign a category.
  if (maxScore < 2) {
    // Fall through to admin by default if any moderate admin signal exists
    // (scheduling / confirmations are by far the most common action type)
    if (adminScore >= 1) return { category: "admin", decisionRequired };
    return { category: undefined, decisionRequired };
  }

  // Prefer critical > admin > personal on ties
  if (criticalScore >= adminScore && criticalScore >= personalScore) {
    return { category: "critical", decisionRequired };
  }
  if (adminScore >= personalScore) {
    return { category: "admin", decisionRequired };
  }
  return { category: "personal", decisionRequired };
}

/**
 * Batch-classify an array of action texts.
 * Returns an array of ClassifyResult in the same order as the input.
 */
export function classifyActions(
  items: Array<{ text: string; priority?: "high" | "medium" | "low" }>
): ClassifyResult[] {
  return items.map((i) => classifyAction(i.text, i.priority));
}
