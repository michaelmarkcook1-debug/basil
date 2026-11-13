import { readUserStore, updateUserStore, writeUserStore } from "@/lib/storage/user-store";
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

function normalise(stored: Partial<AIProjectsData> | null | undefined): AIProjectsData {
  const defaults = defaultProjectsData();
  // Merge stored platforms over defaults so new platforms get defaults
  const platforms = { ...defaults.platforms, ...(stored?.platforms ?? {}) };
  return {
    projects: stored?.projects ?? [],
    platforms,
    lastSyncedAt: stored?.lastSyncedAt,
  };
}

/** Read-only view. A read that feeds a write must go through updateProjectsStore. */
export async function readProjectsStore(username: string, options?: { fresh?: boolean }): Promise<AIProjectsData> {
  const stored = await readUserStore<Partial<AIProjectsData>>(username, STORE_FILE, {}, options);
  return normalise(stored);
}

/** @deprecated Unlocked whole-file write — use updateProjectsStore for every change. */
export async function writeProjectsStore(username: string, data: AIProjectsData): Promise<void> {
  await writeUserStore<AIProjectsData>(username, STORE_FILE, data);
}

/**
 * Locked read-modify-write of the AI projects file: the mutator gets a FRESH
 * copy read under the lock and returns the next value. Every change (the
 * 30-minute sync, an import, an upload, a hide/rename) goes through here.
 * They used to read (possibly a stale per-instance cache), modify and write
 * the whole file unlocked, so the sync could overwrite a hide made while it
 * was fetching, and an import racing the sync was lost (2026-11-10 bug pass, C3).
 *
 * Keep the mutator fast and synchronous — network fetches happen before it.
 * A mutator may throw to abort without writing.
 */
export async function updateProjectsStore(
  username: string,
  mutator: (current: AIProjectsData) => AIProjectsData,
): Promise<AIProjectsData> {
  const next = await updateUserStore<Partial<AIProjectsData>>(username, STORE_FILE, (cur) => mutator(normalise(cur)), {});
  return normalise(next);
}
