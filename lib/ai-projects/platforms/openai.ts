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

interface OAIListResponse<T> {
  object: "list";
  data: T[];
  first_id?: string;
  last_id?: string;
  has_more: boolean;
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

export async function fetchOpenAIProjects(apiKey: string): Promise<AIProject[]> {
  try {
    const assistants = await oaiFetch<OAIListResponse<OAIAssistant>>(
      apiKey,
      "/assistants?limit=20&order=desc"
    );

    const now = new Date().toISOString();

    return assistants.data.map((assistant) => {
      const name = assistant.name ?? `OpenAI assistant ${assistant.id.slice(-6)}`;
      const description = assistant.description ?? "OpenAI Assistant / Codex-adjacent work surface";
      const createdAt = new Date(assistant.created_at * 1000).toISOString();
      const category = classifyCategory(name, description);
      const importance = scoreImportance(createdAt, category);

      return {
        id: `codex:${assistant.id}`,
        platform: "codex" as const,
        externalId: assistant.id,
        name,
        description,
        url: `https://platform.openai.com/assistants/${assistant.id}`,
        createdAt,
        lastActiveAt: createdAt,
        category,
        importance,
        summary: generateSummary({ name, platform: "codex", description, category }),
        hidden: false,
        syncedAt: now,
      };
    });
  } catch (err) {
    console.error("[openai] fetchOpenAIProjects error:", err instanceof Error ? err.message : String(err));
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
