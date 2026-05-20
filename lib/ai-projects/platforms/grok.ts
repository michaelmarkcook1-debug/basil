import type { AIProject } from "../types";

/**
 * Grok (xAI) has no project history API.
 * Connection status is shown via the credential store.
 * Returns empty array — projects are tracked by other signals.
 */
export async function fetchGrokProjects(): Promise<AIProject[]> {
  return [];
}
