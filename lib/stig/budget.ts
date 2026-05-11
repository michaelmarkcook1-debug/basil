// Rough token estimate: 1 token ≈ 4 chars
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Per-source record caps — never send more than these
export const SOURCE_CAPS = {
  slack: 30,
  emails: 20,
  calendar: 15,
  projects: 10,
  actions: 20,
  decisions: 20,
  memory: 20,
  contacts: 10,
  aiProjects: 15,
} as const;

// Max input tokens to send to the model (leaves room for output + system prompt)
export const CONTEXT_INPUT_BUDGET = 18_000; // safe under 30K TPM

// System prompt is ~1-2K tokens; question is typically <500 tokens.
// This leaves ~16K for workspace context, well under the rate limit.
export const SYSTEM_PROMPT_BUDGET = 2_500;
export const QUESTION_BUDGET = 500;
export const WORKSPACE_CONTEXT_BUDGET =
  CONTEXT_INPUT_BUDGET - SYSTEM_PROMPT_BUDGET - QUESTION_BUDGET;
// = 15_000 tokens for workspace context

export interface ContextSection {
  label: string;
  content: string;
  priority: number; // lower = higher priority (0 = always include)
}

/**
 * Truncate a list of context sections to fit within tokenBudget.
 * Sections are included in priority order; lower-priority sections are dropped first.
 * Within each section, content is truncated if needed.
 */
export function truncateSectionsTobudget(
  sections: ContextSection[],
  tokenBudget: number
): string {
  const sorted = [...sections].sort((a, b) => a.priority - b.priority);
  const included: string[] = [];
  let used = 0;

  for (const section of sorted) {
    const sectionTokens = estimateTokens(section.content);
    if (used + sectionTokens <= tokenBudget) {
      included.push(section.content);
      used += sectionTokens;
    } else {
      // Try to include a truncated version
      const remaining = tokenBudget - used;
      if (remaining > 200) {
        const maxChars = remaining * 4;
        const truncated =
          section.content.slice(0, maxChars) +
          "\n[…truncated to fit context budget]";
        included.push(truncated);
        used += remaining;
      }
      // If < 200 tokens left, skip this section entirely
      break;
    }
  }

  return included.join("\n\n");
}
