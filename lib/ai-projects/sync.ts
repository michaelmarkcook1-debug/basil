import { getSettings } from "@/lib/settings/store";
import { readProjectsStore, writeProjectsStore } from "./store";
import { fetchClaudeCodeProjects } from "./platforms/claude-code";
import { fetchGithubProjects } from "./platforms/github";
import { fetchVercelProjects } from "./platforms/vercel";
import { fetchLinearProjects } from "./platforms/linear";
import type { AIProject, AIProjectsData, Platform } from "./types";
import { isLinearConnected } from "@/lib/linear/client";

/** Find words ≥6 chars that are shared between two project names */
function sharedWords(a: string, b: string): string[] {
  const words = (s: string) =>
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 6);
  const setA = new Set(words(a));
  return words(b).filter((w) => setA.has(w));
}

/** Detect related projects: two projects share ≥2 long words in their names */
function detectRelated(projects: AIProject[]): AIProject[] {
  const withRelated = projects.map((p) => ({ ...p, relatedProjectIds: [] as string[] }));
  for (let i = 0; i < withRelated.length; i++) {
    for (let j = i + 1; j < withRelated.length; j++) {
      const shared = sharedWords(withRelated[i].name, withRelated[j].name);
      if (shared.length >= 2) {
        withRelated[i].relatedProjectIds.push(withRelated[j].id);
        withRelated[j].relatedProjectIds.push(withRelated[i].id);
      }
    }
  }
  return withRelated;
}

export async function syncProjects(username: string): Promise<AIProjectsData> {
  const [settings, existing, linearConnected] = await Promise.all([
    getSettings(username),
    readProjectsStore(username),
    isLinearConnected(username).catch(() => false),
  ]);

  const vercelToken = process.env.VERCEL_TOKEN;

  // Fetch all platforms in parallel
  const [claudeCodeProjects, githubProjects, vercelProjects, linearProjects] =
    await Promise.all([
      fetchClaudeCodeProjects(),
      settings.githubToken ? fetchGithubProjects(settings.githubToken) : Promise.resolve([]),
      vercelToken ? fetchVercelProjects(vercelToken) : Promise.resolve([]),
      linearConnected ? fetchLinearProjects(username) : Promise.resolve([]),
    ]);

  const freshProjects = [
    ...claudeCodeProjects,
    ...githubProjects,
    ...vercelProjects,
    ...linearProjects,
  ];

  // Build a map of existing projects keyed by id so we can preserve user overrides
  const existingById = new Map<string, AIProject>();
  for (const p of existing.projects) {
    existingById.set(p.id, p);
  }

  // Merge: preserve categoryOverride, importanceOverride, hidden from existing
  const merged = freshProjects.map((fresh) => {
    const prev = existingById.get(fresh.id);
    if (!prev) return fresh;
    return {
      ...fresh,
      hidden: prev.hidden,
      categoryOverride: prev.categoryOverride,
      importanceOverride: prev.importanceOverride,
    };
  });

  // Detect related projects
  const withRelated = detectRelated(merged);

  const now = new Date().toISOString();

  // Build platform statuses
  const platforms = { ...existing.platforms };

  // claude-code
  platforms["claude-code"] = {
    ...platforms["claude-code"],
    platform: "claude-code",
    label: "Claude Code",
    connected: true,
    lastSyncedAt: now,
    itemCount: claudeCodeProjects.length,
  };

  // github
  if (settings.githubToken) {
    platforms["github"] = {
      ...platforms["github"],
      platform: "github",
      label: "GitHub",
      connected: githubProjects.length > 0 || true,
      lastSyncedAt: now,
      itemCount: githubProjects.length,
      error: githubProjects.length === 0 ? "No repos found or token invalid" : undefined,
    };
  }

  // vercel
  if (vercelToken) {
    platforms["vercel"] = {
      ...platforms["vercel"],
      platform: "vercel",
      label: "Vercel",
      connected: true,
      lastSyncedAt: now,
      itemCount: vercelProjects.length,
    };
  }

  // linear
  if (linearConnected) {
    platforms["linear"] = {
      ...platforms["linear"],
      platform: "linear",
      label: "Linear",
      connected: true,
      lastSyncedAt: now,
      itemCount: linearProjects.length,
    };
  }

  // Platforms that require manual import — mark with setupUrl
  const manualPlatforms: Platform[] = ["claude-chat", "chatgpt", "gemini", "perplexity", "grok", "codex"];
  for (const p of manualPlatforms) {
    if (!platforms[p]?.connected) {
      platforms[p] = {
        ...platforms[p],
        platform: p,
        label: platforms[p]?.label ?? p,
        connected: false,
      };
    }
  }

  const data: AIProjectsData = {
    projects: withRelated,
    platforms,
    lastSyncedAt: now,
  };

  await writeProjectsStore(username, data);
  return data;
}
