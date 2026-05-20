/**
 * Parser for ChatGPT data export format.
 * ChatGPT exports an array of conversation objects:
 * [{ id, title, create_time, update_time, mapping: {...} }, ...]
 * create_time and update_time are Unix timestamps (seconds).
 */

export interface ChatGPTConversation {
  id: string;
  title?: string;
  create_time?: number;
  update_time?: number;
}

export function parseChatGPTExport(
  json: unknown
): { externalId: string; name: string; lastActiveAt?: string }[] {
  if (!Array.isArray(json)) return [];
  return json
    .filter(
      (item): item is ChatGPTConversation =>
        typeof item === "object" && item !== null && typeof item.id === "string"
    )
    .map((item) => ({
      externalId: item.id,
      name: item.title?.trim() || "Untitled conversation",
      lastActiveAt: item.update_time
        ? new Date(item.update_time * 1000).toISOString()
        : item.create_time
          ? new Date(item.create_time * 1000).toISOString()
          : undefined,
    }));
}
