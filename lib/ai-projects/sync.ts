import { updateProjectsStore } from "./store";
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
import { isEnvCredentialOwner } from "@/lib/auth/env-credential-owner";

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

/**
 * Fetch every connected platform and merge the results into the stored list.
 *
 * Fixed 2026-11-10 (bug pass, C3). The sync used to REPLACE the stored list with
 * what it fetched, read at the start and written at the end with no lock:
 *   - imported projects (ChatGPT / Claude.ai exports, basil-sync scrapes) have
 *     no live fetch, so every 30-minute sync deleted them;
 *   - a hide or rename made while the fetches ran was overwritten with the
 *     copy read before them.
 * Now the fetches run first, outside any lock, and the merge runs inside
 * updateProjectsStore on a fresh copy: overrides come from that copy, and a
 * platform's stored projects are replaced only when its live fetch returned
 * projects. Every fetcher returns [] on error, and Perplexity / Grok (and in
 * practice Codex) have no history API, so an empty answer is not evidence
 * that the stored projects are gone — they are carried over.
 */
export async function syncProjects(username: string): Promise<AIProjectsData> {
  const [linearConnected, githubToken, openaiApiKey, geminiApiKey, perplexityKey, grokKey] = await Promise.all([
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

  // The deployment's VERCEL_TOKEN (and the server's ~/.claude folder) are the
  // owner's, so only the owner sees what they list.
  const owner = isEnvCredentialOwner(username);
  const vercelToken = owner ? process.env.VERCEL_TOKEN : undefined;

  // Fetch all platforms in parallel
  const [claudeCodeProjects, githubProjects, vercelProjects, linearProjects, openaiProjects, perplexityProjects, grokProjects] =
    await Promise.all([
      owner ? fetchClaudeCodeProjects() : Promise.resolve([]),
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

  // Platforms whose stored projects this run replaces (see the doc comment).
  const replaced = new Set<Platform>(freshProjects.map((p) => p.platform));
  const now = new Date().toISOString();

  /** Platform statuses for this run, built over the fresh stored statuses. */
  function platformStatuses(stored: AIProjectsData["platforms"]): AIProjectsData["platforms"] {
    const platforms = { ...stored };

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

    // openai / codex — OpenAI exposes no usable project/thread-history API, so an
    // empty result is EXPECTED and is NOT a bad key. Only mark Codex connected when
    // it genuinely returned projects; otherwise show a quiet not-connected state
    // with no misleading red "invalid key" error. A scraped Codex import keeps its
    // own status.
    if (openaiApiKey && (openaiProjects.length > 0 || !platforms["codex"]?.scraped)) {
      platforms["codex"] = {
        ...platforms["codex"],
        platform: "codex",
        label: "Codex (OpenAI)",
        connected: openaiProjects.length > 0,
        lastSyncedAt: now,
        itemCount: openaiProjects.length,
        error: undefined,
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
        itemCount: platforms["gemini"]?.scraped ? platforms["gemini"].itemCount : 0,
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
        itemCount: platforms["perplexity"]?.scraped ? platforms["perplexity"].itemCount : 0,
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
        itemCount: platforms["grok"]?.scraped ? platforms["grok"].itemCount : 0,
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

    return platforms;
  }

  return updateProjectsStore(username, (current) => {
    // Overrides from the FRESH copy read under the lock — a hide or rename made
    // while the fetches ran is kept.
    const currentById = new Map<string, AIProject>();
    for (const p of current.projects) currentById.set(p.id, p);

    // Merge: preserve categoryOverride, importanceOverride, hidden from the stored copy
    const merged = freshProjects.map((fresh) => {
      const prev = currentById.get(fresh.id);
      if (!prev) return fresh;
      return {
        ...fresh,
        hidden: prev.hidden,
        categoryOverride: prev.categoryOverride,
        importanceOverride: prev.importanceOverride,
      };
    });

    // Carry over every stored project of a platform this run did not replace —
    // imported/scraped projects, and platforms whose fetch came back empty.
    const freshIds = new Set(merged.map((p) => p.id));
    const carried = current.projects.filter((p) => !replaced.has(p.platform) && !freshIds.has(p.id));

    // Detect related projects
    const withRelated = detectRelated([...merged, ...carried]);

    return {
      projects: withRelated,
      platforms: platformStatuses(current.platforms),
      lastSyncedAt: now,
    };
  });
}
