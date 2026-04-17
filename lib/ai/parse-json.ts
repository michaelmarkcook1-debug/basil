/**
 * Parse JSON from AI response, stripping markdown code fences if present.
 * Claude sometimes wraps JSON in ```json ... ``` despite being told not to.
 */
export function parseAIJson<T>(text: string): T {
  let cleaned = text.trim();

  // Strip markdown code fences
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  return JSON.parse(cleaned);
}
