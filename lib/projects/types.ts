export type ProjectCategory = "work" | "personal" | "unknown";
export type ProjectStatus = "moving" | "stalled" | "blocked" | "needs-review" | "quiet";
export type ProjectPriority = "critical" | "high" | "medium" | "low";

export type ProjectSignalSource =
  | "slack"
  | "linear"
  | "action"
  | "decision"
  | "memory"
  | "ai-project"
  | "zoom"
  | "email"
  | "google"
  | "notion"
  | "manual";

export interface ProjectSignal {
  id: string;
  source: ProjectSignalSource;
  title: string;
  summary: string;
  occurredAt: string;
  url?: string;
  /** 1-5 rough signal strength; used only for ranking. */
  strength: number;
  /** Optional platform label for AI/dev tools, e.g. "Claude Code", "Codex". */
  platform?: string;
}

export interface CanonicalProject {
  id: string;
  name: string;
  category: ProjectCategory;
  status: ProjectStatus;
  priority: ProjectPriority;
  summary: string;
  nextBestAction: string;
  lastActiveAt: string;
  signals: ProjectSignal[];
  sourceBreakdown: Partial<Record<ProjectSignalSource, number>>;
  relatedPlatforms: string[];
  openActionCount: number;
  decisionCount: number;
  blockerCount: number;
  aiWorkCount: number;
  riskNotes: string[];
}

export interface ProjectTruthData {
  generatedAt: string;
  projects: CanonicalProject[];
  sourceCounts: {
    slack: number;
    linear: number;
    actions: number;
    decisions: number;
    memories: number;
    aiProjects: number;
    manual?: number;
  };
}
