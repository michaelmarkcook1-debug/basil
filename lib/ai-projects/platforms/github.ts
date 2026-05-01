import type { AIProject } from "../types";
import { classifyCategory, scoreImportance, generateSummary } from "../classifier";

interface GithubRepo {
  id: number;
  full_name: string;
  description: string | null;
  html_url: string;
  created_at: string;
  pushed_at: string;
  fork: boolean;
  private: boolean;
  owner: { type: string };
}

export async function fetchGithubProjects(githubToken: string): Promise<AIProject[]> {
  try {
    const res = await fetch(
      "https://api.github.com/user/repos?sort=pushed&per_page=10&affiliation=owner,collaborator",
      {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "basil-exec-assistant",
        },
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!res.ok) return [];

    const repos = (await res.json()) as GithubRepo[];
    const now = new Date().toISOString();

    return repos.map((repo) => {
      const name = repo.full_name;
      const description = repo.description ?? undefined;
      const lastActiveAt = repo.pushed_at;
      const createdAt = repo.created_at;

      const category = classifyCategory(name, description);
      const importance = scoreImportance(lastActiveAt, category);

      return {
        id: `github:${repo.id}`,
        platform: "github" as const,
        externalId: String(repo.id),
        name,
        description,
        url: repo.html_url,
        createdAt,
        lastActiveAt,
        category,
        importance,
        summary: generateSummary({ name, platform: "github", description, category }),
        hidden: false,
        syncedAt: now,
      };
    });
  } catch {
    return [];
  }
}
