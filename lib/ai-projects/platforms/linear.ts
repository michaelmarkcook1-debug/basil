import type { AIProject } from "../types";
import { getMyOpenIssues } from "@/lib/linear/client";
import { classifyCategory, scoreImportance, generateSummary } from "../classifier";

export async function fetchLinearProjects(username: string): Promise<AIProject[]> {
  try {
    const issues = await getMyOpenIssues(username);
    const now = new Date().toISOString();

    return issues.map((issue) => {
      const name = `${issue.identifier} ${issue.title}`;
      const description = issue.description?.substring(0, 120);
      const lastActiveAt = issue.updatedAt;
      const createdAt = issue.createdAt;
      const category = classifyCategory(name, description);
      const importance = scoreImportance(lastActiveAt, category);

      return {
        id: `linear:${issue.id}`,
        platform: "linear" as const,
        externalId: issue.id,
        name,
        description,
        url: issue.url,
        createdAt,
        lastActiveAt,
        category,
        importance,
        summary: generateSummary({ name, platform: "linear", description, category }),
        hidden: false,
        syncedAt: now,
      };
    });
  } catch {
    return [];
  }
}
