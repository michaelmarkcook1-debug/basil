import type { AIProject } from "../types";

/**
 * Perplexity has no project history API.
 * Connection status is shown via the credential store.
 * Returns empty array — projects are tracked by other signals.
 */
export async function fetchPerplexityProjects(): Promise<AIProject[]> {
  return [];
}
