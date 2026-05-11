export type Platform =
  | "claude-code" | "claude-chat" | "claude-cowork"
  | "github" | "vercel" | "linear"
  | "chatgpt" | "gemini" | "perplexity" | "grok" | "codex";

export type Importance = "critical" | "high" | "medium" | "low";
export type Category = "work" | "personal" | "unknown";

export interface AIProject {
  id: string;                    // platform:externalId
  platform: Platform;
  externalId: string;
  name: string;
  description?: string;
  url?: string;
  createdAt: string;             // ISO date
  lastActiveAt: string;          // ISO date
  category: Category;
  importance: Importance;
  summary: string;               // 1-sentence summary
  hidden: boolean;
  relatedProjectIds?: string[];  // other project IDs that seem related
  // User overrides
  categoryOverride?: Category;
  importanceOverride?: Importance;
  syncedAt: string;
}

export interface PlatformStatus {
  platform: Platform;
  label: string;
  connected: boolean;
  /** When true, data came from basil-sync scraping rather than a live API */
  scraped?: boolean;
  lastSyncedAt?: string;
  error?: string;
  itemCount?: number;
  setupUrl?: string;             // link to setup instructions
}

export interface AIProjectsData {
  projects: AIProject[];
  platforms: Record<Platform, PlatformStatus>;
  lastSyncedAt?: string;
}

export const PLATFORM_LABELS: Record<Platform, string> = {
  "claude-code": "Claude Code",
  "claude-chat": "Claude.ai",
  "claude-cowork": "Claude Cowork",
  "github": "GitHub",
  "vercel": "Vercel",
  "linear": "Linear",
  "chatgpt": "ChatGPT",
  "gemini": "Gemini",
  "perplexity": "Perplexity",
  "grok": "Grok",
  "codex": "Codex",
};
