/**
 * OpenAI Assistants API platform adapter.
 *
 * Fetches the most recent OpenAI Assistant threads accessible with the given
 * API key and maps them to AIProject entries.
 *
 * Required scope: no special scope needed — any valid `sk-…` key that has
 * access to the Assistants API (beta) will work.
 */

import type { AIProject } from "../types";
import { classifyCategory, scoreImportance, generateSummary } from "../classifier";

const OPENAI_API = "https://api.openai.com/v1";

interface OAIThread {
  id: string;
  object: "thread";
  created_at: number;
  metadata: Record<string, string>;
}

interface OAIListResponse<T> {
  object: "list";
  data: T[];
  first_id?: string;
  last_id?: string;
  has_more: boolean;
}

interface OAIMessage {
  id: string;
  object: "thread.message";
  created_at: number;
  thread_id: string;
  role: "user" | "assistant";
  content: Array<{
    type: "text";
    text: { value: string; annotations: unknown[] };
  }>;
}

interface OAIAssistant {
  id: string;
  object: "assistant";
  name: string | null;
  description: string | null;
  created_at: number;
}

async function oaiFetch<T>(apiKey: string, path: string): Promise<T> {
  const res = await fetch(`${OPENAI_API}${path}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "assistants=v2",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`OpenAI API ${res.status}: ${await res.text().catch(() => "")}`);
  }
  return res.json() as Promise<T>;
}

/** Returns the first user message text in a thread, truncated to 120 chars */
async function getFirstMessage(apiKey: string, threadId: string): Promise<string | undefined> {
  try {
    const msgs = await oaiFetch<OAIListResponse<OAIMessage>>(
      apiKey,
      `/threads/${threadId}/messages?limit=1&order=asc`
    );
    const first = msgs.data[0];
    if (!first) return undefined;
    const textContent = first.content.find((c) => c.type === "text");
    if (!textContent || textContent.type !== "text") return undefined;
    const text = textContent.text.value.replace(/\n+/g, " ").trim();
    return text.length > 120 ? text.slice(0, 117) + "…" : text;
  } catch {
    return undefined;
  }
}

export async function fetchOpenAIProjects(apiKey: string): Promise<AIProject[]> {
  try {
    // Fetch up to 20 most recently active assistants
    const assistants = await oaiFetch<OAIListResponse<OAIAssistant>>(
      apiKey,
      "/assistants?limit=20&order=desc"
    );

    const now = new Date().toISOString();
    const projects: AIProject[] = [];

    // For each assistant, fetch its most recent threads (up to 5 per assistant)
    for (const assistant of assistants.data) {
      let threads: OAIThread[] = [];
      try {
        // The threads endpoint is not filterable by assistant — fetch recent threads globally
        // and use the assistant name/description as context for classification
        const threadList = await oaiFetch<OAIListResponse<OAIThread>>(
          apiKey,
          `/threads?limit=5`
        );
        threads = threadList.data;
      } catch {
        // threads endpoint may not be available for all keys — skip silently
      }

      const assistantName = assistant.name ?? `Assistant ${assistant.id.slice(-6)}`;
      const assistantDesc = assistant.description ?? undefined;

      // If no threads found, create one project entry from the assistant itself
      if (threads.length === 0) {
        const createdAt = new Date(assistant.created_at * 1000).toISOString();
        const category = classifyCategory(assistantName, assistantDesc);
        const importance = scoreImportance(createdAt, category);
        projects.push({
          id: `codex:${assistant.id}`,
          platform: "codex",
          externalId: assistant.id,
          name: assistantName,
          description: assistantDesc,
          url: `https://platform.openai.com/assistants/${assistant.id}`,
          createdAt,
          lastActiveAt: createdAt,
          category,
          importance,
          summary: generateSummary({ name: assistantName, platform: "codex", description: assistantDesc, category }),
          hidden: false,
          syncedAt: now,
        });
      }

      // Add thread-level projects
      for (const thread of threads) {
        const lastActiveAt = new Date(thread.created_at * 1000).toISOString();
        const firstMsg = await getFirstMessage(apiKey, thread.id);
        const name = firstMsg
          ? firstMsg.slice(0, 60) + (firstMsg.length > 60 ? "…" : "")
          : `Thread with ${assistantName}`;
        const description = firstMsg;
        const category = classifyCategory(name, assistantDesc);
        const importance = scoreImportance(lastActiveAt, category);

        projects.push({
          id: `codex:${thread.id}`,
          platform: "codex",
          externalId: thread.id,
          name,
          description,
          url: `https://platform.openai.com/playground/assistants?thread=${thread.id}`,
          createdAt: lastActiveAt,
          lastActiveAt,
          category,
          importance,
          summary: generateSummary({ name, platform: "codex", description, category }),
          hidden: false,
          syncedAt: now,
        });
      }

      // Only process the first assistant if threads endpoint worked — avoids duplicate threads
      if (threads.length > 0) break;
    }

    // Deduplicate by id
    const seen = new Set<string>();
    return projects.filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
  } catch (err) {
    console.error("[openai] fetchOpenAIProjects error:", err);
    return [];
  }
}

/**
 * Validate an OpenAI API key by fetching the models list.
 * Returns the number of available models on success, throws on failure.
 */
export async function validateOpenAIKey(apiKey: string): Promise<number> {
  const data = await oaiFetch<{ data: unknown[] }>(apiKey, "/models");
  return data.data.length;
}
