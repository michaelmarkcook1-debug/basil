import type { ActionItem } from "@/lib/types/action";
import type { Decision } from "@/lib/types/decision";
import type { CalendarEvent } from "@/lib/google/calendar";
import type { GmailMessage } from "@/lib/google/gmail";
import type { Memory } from "@/lib/memory/types";
import type { ProjectTruthData } from "@/lib/projects/types";
import type { SlackCommandData } from "@/lib/stig/slack-command";
import type { AIProject } from "@/lib/ai-projects/types";

export type StigMode = "general" | "briefing" | "voice" | "projects" | "slack";

export interface StigAskRequest {
  question: string;
  mode?: StigMode;
  voice?: boolean;
  includeSources?: boolean;
}

export interface StigSourceStatus {
  source: string;
  status: "ok" | "empty" | "error";
  count?: number;
  error?: string;
}

export interface StigContextBundle {
  generatedAt: string;
  timezone: string;
  sources: StigSourceStatus[];
  calendar: CalendarEvent[];
  emails: GmailMessage[];
  slackCommand: SlackCommandData | null;
  actions: ActionItem[];
  decisions: Decision[];
  memories: Memory[];
  projectTruth: ProjectTruthData | null;
  /** AI projects (Claude, GitHub, Vercel, etc.) — used for "AI work needing review" briefing section */
  aiProjects: AIProject[];
  /** Compact WhatsApp signal summary — null if no index exists or index is >90 days old. */
  whatsAppSummary?: string | null;
  /** Recent Linear issues (assigned or created) — capped at 10, last 14 days. */
  linearActivity: Array<{ personName: string; personEmail?: string; updatedAt: string; description: string }>;
}

export interface StigAskResult {
  ok: true;
  answer: string;
  mode: StigMode;
  generatedAt: string;
  authMode: "session" | "token";
  sources?: StigSourceStatus[];
}

export interface StigBriefingResult {
  ok: true;
  briefing: string;
  generatedAt: string;
  sources: StigSourceStatus[];
}
