/**
 * Parser for Anthropic Claude.ai data export format.
 * Anthropic exports conversations as a JSON array:
 * [{ uuid, name, created_at, updated_at, ... }, ...]
 */

export interface ClaudeAIConversation {
  uuid: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
}

export function parseClaudeAIExport(
  json: unknown
): { externalId: string; name: string; lastActiveAt?: string }[] {
  if (!Array.isArray(json)) return [];
  return json
    .filter(
      (item): item is ClaudeAIConversation =>
        typeof item === "object" && item !== null && typeof item.uuid === "string"
    )
    .map((item) => ({
      externalId: item.uuid,
      name: item.name?.trim() || "Untitled conversation",
      lastActiveAt: item.updated_at ?? item.created_at,
    }));
}
