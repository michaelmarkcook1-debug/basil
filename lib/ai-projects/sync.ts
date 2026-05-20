import { readProjectsStore, writeProjectsStore } from "./store";
import { fetchClaudeCodeProjects } from "./platforms/claude-code";
import { fetchGithubProjects } from "./platforms/github";
import { fetchVercelProjects } from "./platforms/vercel";
import { fetchLinearProjects } from "./platforms/linear";
import { fetchOpenAIProjects } from "./platforms/openai";
import { fetchPerplexityProjects } from "./platforms/perplexity";
import { fetchGrokProjects } from "./platforms/grok";
import type { AIProject, AIProjectsData, Platform } from "./types";
import { isLinearConnected } from "@/lib/linear/client";
import { getAIPlatformKey } from "@/lib/ai-platforms/credentials";

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
  const [existing, linearConnected, githubToken, openaiApiKey, geminiApiKey, perplexityKey, grokKey] = await Promise.all([
    readProjectsStore(username),
    isLinearConnected(username).catch((err) => {
      console.error("[ai-projects] Linear status check failed:", err instanceof Error ? err.message : String(err));
      return false;
    }),
    getAIPlatformKey(username, "github").catch((err) => {
      console.error("[ai-projects] GitHub key read failed:", err instanceof Error ? err.message : String(err));
      return null;
    }),
    getAIPlatformKey(username, "openai").catch((err) => {
      console.error("[ai-projects] OpenAI key read failed:", err instanceof Error ? err.message : String(err));
      return null;
    }),
    getAIPlatformKey(username, "gemini").catch((err) => {
      console.error("[ai-projects] Gemini key read failed:", err instanceof Error ? err.message : String(err));
      return null;
    }),
    getAIPlatformKey(username, "perplexity").catch((err) => {
      console.error("[ai-projects] Perplexity key read failed:", err instanceof Error ? err.message : String(err));
      return null;
    }),
    getAIPlatformKey(username, "grok").catch((err) => {
      console.error("[ai-projects] Grok key read failed:", err instanceof Error ? err.message : String(err));
      return null;
    }),
  ]);

  const vercelToken = process.env.VERCEL_TOKEN;

  // Fetch all platforms in parallel
  const [claudeCodeProjects, githubProjects, vercelProjects, linearProjects, openaiProjects, perplexityProjects, grokProjects] =
    await Promise.all([
      fetchClaudeCodeProjects(),
      githubToken ? fetchGithubProjects(githubToken) : Promise.resolve([]),
      vercelToken ? fetchVercelProjects(vercelToken) : Promise.resolve([]),
      linearConnected ? fetchLinearProjects(username) : Promise.resolve([]),
      openaiApiKey ? fetchOpenAIProjects(openaiApiKey) : Promise.resolve([]),
      perplexityKey ? fetchPerplexityProjects() : Promise.resolve([]),
      grokKey ? fetchGrokProjects() : Promise.resolve([]),
    ]);

  const freshProjects = [
    ...claudeCodeProjects,
    ...githubProjects,
    ...vercelProjects,
    ...linearProjects,
    ...openaiProjects,
    ...perplexityProjects,
    ...grokProjects,
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
  if (githubToken) {
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

  // openai / codex
  if (openaiApiKey) {
    platforms["codex"] = {
      ...platforms["codex"],
      platform: "codex",
      label: "Codex (OpenAI)",
      connected: openaiProjects.length > 0,
      lastSyncedAt: now,
      itemCount: openaiProjects.length,
      error: openaiProjects.length === 0 ? "No threads found or API key invalid" : undefined,
    };
  }

  // gemini — API key connected, no project history API
  if (geminiApiKey) {
    platforms["gemini"] = {
      ...platforms["gemini"],
      platform: "gemini",
      label: "Gemini",
      connected: true,
      lastSyncedAt: now,
      itemCount: 0,
    };
  }

  // perplexity — API key connected, no project history API
  if (perplexityKey) {
    platforms["perplexity"] = {
      ...platforms["perplexity"],
      platform: "perplexity",
      label: "Perplexity",
      connected: true,
      lastSyncedAt: now,
      itemCount: 0,
    };
  }

  // grok — API key connected, no project history API
  if (grokKey) {
    platforms["grok"] = {
      ...platforms["grok"],
      platform: "grok",
      label: "Grok",
      connected: true,
      lastSyncedAt: now,
      itemCount: 0,
    };
  }

  // Platforms that require manual import — mark as disconnected if not already connected
  const manualPlatforms: Platform[] = ["claude-chat", "claude-cowork", "chatgpt"];
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
