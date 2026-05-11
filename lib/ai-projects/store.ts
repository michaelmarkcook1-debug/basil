import { readUserStore, writeUserStore } from "@/lib/storage/user-store";
import type { AIProjectsData, Platform, PlatformStatus } from "./types";
import { PLATFORM_LABELS } from "./types";

const STORE_FILE = "ai-projects.json";

function defaultPlatformStatus(platform: Platform): PlatformStatus {
  const setupUrls: Partial<Record<Platform, string>> = {
    "chatgpt": "https://chat.openai.com/",
    "gemini": "https://gemini.google.com/",
    "perplexity": "https://www.perplexity.ai/",
    "grok": "https://grok.x.ai/",
    "codex": "https://platform.openai.com/codex",
  };
  return {
    platform,
    label: PLATFORM_LABELS[platform],
    connected: false,
    setupUrl: setupUrls[platform],
  };
}

function defaultProjectsData(): AIProjectsData {
  const platforms = {} as Record<Platform, PlatformStatus>;
  const allPlatforms: Platform[] = [
    "claude-code", "claude-chat", "claude-cowork", "github", "vercel", "linear",
    "chatgpt", "gemini", "perplexity", "grok", "codex",
  ];
  for (const p of allPlatforms) {
    platforms[p] = defaultPlatformStatus(p);
  }
  return { projects: [], platforms };
}

export async function readProjectsStore(username: string): Promise<AIProjectsData> {
  const stored = await readUserStore<Partial<AIProjectsData>>(username, STORE_FILE, {});
  const defaults = defaultProjectsData();
  // Merge stored platforms over defaults so new platforms get defaults
  const platforms = { ...defaults.platforms, ...(stored.platforms ?? {}) };
  return {
    projects: stored.projects ?? [],
    platforms,
    lastSyncedAt: stored.lastSyncedAt,
  };
}

export async function writeProjectsStore(username: string, data: AIProjectsData): Promise<void> {
  await writeUserStore<AIProjectsData>(username, STORE_FILE, data);
}
