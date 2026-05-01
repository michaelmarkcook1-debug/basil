import type { AIProject } from "../types";
import { classifyCategory, scoreImportance, generateSummary } from "../classifier";

interface VercelProject {
  id: string;
  name: string;
  framework?: string | null;
  updatedAt?: number | string | null;
  createdAt?: number | string | null;
}

interface VercelDeployment {
  name: string;
  createdAt: number;
  url?: string;
}

function toIso(ts: number | string | null | undefined): string {
  if (!ts) return new Date().toISOString();
  if (typeof ts === "number") return new Date(ts).toISOString();
  return new Date(ts).toISOString();
}

export async function fetchVercelProjects(vercelToken: string): Promise<AIProject[]> {
  try {
    const [projectsRes, deploymentsRes] = await Promise.allSettled([
      fetch("https://api.vercel.com/v9/projects?limit=10", {
        headers: { Authorization: `Bearer ${vercelToken}` },
        signal: AbortSignal.timeout(10_000),
      }),
      fetch("https://api.vercel.com/v6/deployments?limit=10", {
        headers: { Authorization: `Bearer ${vercelToken}` },
        signal: AbortSignal.timeout(10_000),
      }),
    ]);

    if (projectsRes.status !== "fulfilled" || !projectsRes.value.ok) return [];

    const projectsData = await projectsRes.value.json() as { projects?: VercelProject[] };
    const projects = projectsData.projects ?? [];

    // Build a map of latest deploy timestamp per project name
    const deployTimes = new Map<string, number>();
    if (deploymentsRes.status === "fulfilled" && deploymentsRes.value.ok) {
      try {
        const deplData = await deploymentsRes.value.json() as { deployments?: VercelDeployment[] };
        for (const d of deplData.deployments ?? []) {
          const existing = deployTimes.get(d.name) ?? 0;
          if (d.createdAt > existing) deployTimes.set(d.name, d.createdAt);
        }
      } catch {
        // ignore deployments data errors
      }
    }

    const now = new Date().toISOString();

    return projects.map((proj) => {
      const name = proj.name;
      const deployTime = deployTimes.get(name);
      const lastActiveAt = deployTime ? new Date(deployTime).toISOString() : toIso(proj.updatedAt);
      const createdAt = toIso(proj.createdAt);
      const url = `https://vercel.com/dashboard`;
      const category = classifyCategory(name);
      const importance = scoreImportance(lastActiveAt, category);

      return {
        id: `vercel:${proj.id}`,
        platform: "vercel" as const,
        externalId: proj.id,
        name,
        url,
        createdAt,
        lastActiveAt,
        category,
        importance,
        summary: generateSummary({ name, platform: "vercel", category }),
        hidden: false,
        syncedAt: now,
      };
    });
  } catch {
    return [];
  }
}
