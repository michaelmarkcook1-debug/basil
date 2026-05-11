import { listActions } from "@/lib/actions/store";
import { listDecisions } from "@/lib/decisions/store";
import { listMemories } from "@/lib/memory/store";
import { getMyOpenIssues } from "@/lib/linear/client";
import { getRecentSlackMessages } from "@/lib/slack/client";
import { readProjectsStore } from "@/lib/ai-projects/store";
import { PLATFORM_LABELS } from "@/lib/ai-projects/types";
import { readUserStore } from "@/lib/storage/user-store";
import type { AIProject, Importance } from "@/lib/ai-projects/types";
import type {
  CanonicalProject,
  ProjectCategory,
  ProjectPriority,
  ProjectSignal,
  ProjectSignalSource,
  ProjectStatus,
  ProjectTruthData,
} from "./types";

type MutableProject = CanonicalProject & { score: number };

const KNOWN_PROJECTS = [
  "AnalystGenius",
  "TalentGenius",
  "Basil",
  "The Stig",
  "Stig Cloud",
  "Executive OS",
  "Slack Command Centre",
  "Project Truth Layer",
  "AI Command Centre",
  "Google Workspace",
  "Apple iCloud",
  "WhatsApp",
  "Zoom",
  "Linear",
  "Notion",
  "ChatGPT",
  "Codex",
  "Claude",
  "Claude Code",
  "Claude Cowork",
  "Gemini",
] as const;

const GENERIC_PROJECT_TERMS = new Set([
  "project",
  "projects",
  "dashboard",
  "platform",
  "backend",
  "frontend",
  "api",
  "app",
  "work",
  "meeting",
  "briefing",
]);

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "unknown";
}

function normaliseName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (/^the stig$/i.test(trimmed)) return "The Stig";
  if (/^stig cloud/i.test(trimmed)) return "The Stig Cloud App";
  if (/^basil/i.test(trimmed)) return "Basil";
  if (/^ag\b|analyst genius/i.test(trimmed)) return "AnalystGenius";
  if (/^tg\b|talent genius/i.test(trimmed)) return "TalentGenius";
  if (/claude code/i.test(trimmed)) return "Claude Code";
  if (/claude cowork|claude co-work/i.test(trimmed)) return "Claude Cowork";
  return trimmed;
}

function categoryFor(name: string, text = ""): ProjectCategory {
  const haystack = `${name} ${text}`.toLowerCase();
  if (/family|home|holiday|personal|health|dentist|doctor|school|house|travel admin/.test(haystack)) {
    return "personal";
  }
  if (/analystgenius|talentgenius|basil|stig|linear|slack|notion|codex|claude|gemini|chatgpt|google workspace|zoom|vercel|github|product|sales|gtm|investor|board|customer|client|team/.test(haystack)) {
    return "work";
  }
  return "unknown";
}

function projectNamesFromText(text: string, fallback?: string): string[] {
  const candidates = new Set<string>();
  const haystack = text || "";

  for (const known of KNOWN_PROJECTS) {
    const pattern = new RegExp(`\\b${known.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}\\b`, "i");
    if (pattern.test(haystack)) candidates.add(normaliseName(known));
  }

  // Pull compact product-style names: AnalystGenius, Stig Cloud, Vercel Deploy, etc.
  for (const match of haystack.matchAll(/\b([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+){0,3})\b/g)) {
    const phrase = match[1].trim();
    const words = phrase.split(/\s+/);
    if (words.length === 1 && phrase.length < 6) continue;
    if (GENERIC_PROJECT_TERMS.has(phrase.toLowerCase())) continue;
    if (/^(Michael|Basil|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/i.test(phrase)) continue;
    if (/(Genius|Stig|Basil|Claude|Gemini|Codex|Slack|Linear|Notion|Zoom|Google|Apple|WhatsApp|Vercel|GitHub)/i.test(phrase)) {
      candidates.add(normaliseName(phrase));
    }
  }

  if (candidates.size === 0 && fallback) candidates.add(normaliseName(fallback));
  return Array.from(candidates).slice(0, 3);
}

function priorityRank(p: ProjectPriority): number {
  return { critical: 0, high: 1, medium: 2, low: 3 }[p];
}

function importanceToPriority(importance?: Importance): ProjectPriority {
  if (importance === "critical") return "critical";
  if (importance === "high") return "high";
  if (importance === "medium") return "medium";
  return "low";
}

function createProject(name: string, category: ProjectCategory): MutableProject {
  const now = new Date(0).toISOString();
  return {
    id: slugify(name),
    name,
    category,
    status: "quiet",
    priority: "low",
    summary: "",
    nextBestAction: "Review the source signals and decide the next concrete move.",
    lastActiveAt: now,
    signals: [],
    sourceBreakdown: {},
    relatedPlatforms: [],
    openActionCount: 0,
    decisionCount: 0,
    blockerCount: 0,
    aiWorkCount: 0,
    riskNotes: [],
    score: 0,
  };
}

function addSignal(
  map: Map<string, MutableProject>,
  name: string,
  category: ProjectCategory,
  signal: ProjectSignal,
  options?: {
    priority?: ProjectPriority;
    blocker?: boolean;
    action?: boolean;
    decision?: boolean;
    aiWork?: boolean;
    risk?: string;
  }
) {
  const canonicalName = normaliseName(name);
  const id = slugify(canonicalName);
  const existing = map.get(id) ?? createProject(canonicalName, category);
  if (existing.category === "unknown" && category !== "unknown") existing.category = category;

  existing.signals.push(signal);
  existing.sourceBreakdown[signal.source] = (existing.sourceBreakdown[signal.source] ?? 0) + 1;
  existing.lastActiveAt =
    new Date(signal.occurredAt).getTime() > new Date(existing.lastActiveAt).getTime()
      ? signal.occurredAt
      : existing.lastActiveAt;
  existing.score += signal.strength;
  if (signal.platform && !existing.relatedPlatforms.includes(signal.platform)) {
    existing.relatedPlatforms.push(signal.platform);
  }

  if (options?.priority && priorityRank(options.priority) < priorityRank(existing.priority)) {
    existing.priority = options.priority;
  }
  if (options?.blocker) existing.blockerCount += 1;
  if (options?.action) existing.openActionCount += 1;
  if (options?.decision) existing.decisionCount += 1;
  if (options?.aiWork) existing.aiWorkCount += 1;
  if (options?.risk && !existing.riskNotes.includes(options.risk)) existing.riskNotes.push(options.risk);

  map.set(id, existing);
}

function looksBlocked(text: string): boolean {
  return /\b(blocked|blocker|stuck|waiting on|can't proceed|cannot proceed|at risk|risk|urgent|escalat)/i.test(text);
}

function summariseProject(p: MutableProject): CanonicalProject {
  const sourceCount = Object.keys(p.sourceBreakdown).length;
  const recentSignals = p.signals
    .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
    .slice(0, 12);

  const status: ProjectStatus =
    p.blockerCount > 0 ? "blocked" :
    p.openActionCount > 0 || p.decisionCount > 0 ? "moving" :
    sourceCount >= 2 ? "moving" :
    p.aiWorkCount > 0 ? "needs-review" :
    "quiet";

  const priority: ProjectPriority =
    p.blockerCount > 0 && p.priority !== "critical" ? "high" :
    p.priority;

  const parts = [
    `${sourceCount} source${sourceCount === 1 ? "" : "s"}`,
    p.openActionCount ? `${p.openActionCount} open action${p.openActionCount === 1 ? "" : "s"}` : "",
    p.decisionCount ? `${p.decisionCount} decision${p.decisionCount === 1 ? "" : "s"}` : "",
    p.blockerCount ? `${p.blockerCount} blocker${p.blockerCount === 1 ? "" : "s"}` : "",
    p.aiWorkCount ? `${p.aiWorkCount} AI work item${p.aiWorkCount === 1 ? "" : "s"}` : "",
  ].filter(Boolean);

  const nextBestAction =
    p.blockerCount > 0
      ? "Clear the blocker or explicitly assign an owner before the day moves on."
      : p.openActionCount > 0
        ? "Review the open actions and close, delegate, or re-date the next one."
        : p.aiWorkCount > 0
          ? "Review AI-generated work and decide whether to accept, redirect, or discard it."
          : p.decisionCount > 0
            ? "Check whether the recent decision has follow-up actions attached."
            : "Confirm whether this is still active or archive it from attention.";

  return {
    ...p,
    status,
    priority,
    summary: parts.length ? parts.join(" · ") : "Low-signal project; verify whether it is still active.",
    nextBestAction,
    signals: recentSignals,
  };
}

function aiProjectPlatformLabel(project: AIProject): string {
  return PLATFORM_LABELS[project.platform] ?? project.platform;
}

/**
 * Build Basil's canonical Project Truth Layer.
 *
 * This deliberately uses conservative, source-attributed heuristics. It should
 * be useful without pretending to know more than the connected systems prove.
 */
const MANUAL_PROJECTS_FILE = "manual-projects.json";

export async function buildProjectTruth(username: string): Promise<ProjectTruthData> {
  const [
    actions,
    decisions,
    memories,
    aiProjectsData,
    linearIssues,
    slackMessages,
    manualProjects,
  ] = await Promise.all([
    listActions(username).catch(() => []),
    listDecisions(username).catch(() => []),
    listMemories(username).catch(() => []),
    readProjectsStore(username).catch(() => ({ projects: [], platforms: {} as never })),
    getMyOpenIssues(username).catch(() => []),
    getRecentSlackMessages(username, 60).catch(() => []),
    readUserStore<CanonicalProject[]>(username, MANUAL_PROJECTS_FILE, []).catch(() => []),
  ]);

  const map = new Map<string, MutableProject>();

  // ── Manual projects — always included first so they appear even with no integrations ──
  for (const mp of manualProjects) {
    const name = normaliseName(mp.name);
    const existing = map.get(name);
    if (!existing) {
      // Seed the map directly with the stored canonical project
      map.set(name, {
        ...mp,
        name,
        score: 10, // manual projects always surface
      });
    }
  }

  for (const project of aiProjectsData.projects ?? []) {
    if (project.hidden) continue;
    const name = normaliseName(project.name);
    const category = project.categoryOverride ?? project.category ?? categoryFor(name, project.description);
    const platform = aiProjectPlatformLabel(project);
    addSignal(map, name, category, {
      id: project.id,
      source: "ai-project",
      title: project.name,
      summary: project.summary || project.description || "AI project activity",
      occurredAt: project.lastActiveAt,
      url: project.url,
      strength: project.importance === "critical" ? 5 : project.importance === "high" ? 4 : 2,
      platform,
    }, {
      priority: importanceToPriority(project.importanceOverride ?? project.importance),
      aiWork: true,
    });
  }

  for (const issue of linearIssues) {
    const candidates = projectNamesFromText(`${issue.project?.name ?? ""} ${issue.title} ${issue.description ?? ""}`, issue.project?.name ?? "Linear product work");
    for (const name of candidates) {
      const text = `${issue.identifier}: ${issue.title}`;
      const blocked = looksBlocked(`${issue.state.name} ${issue.title} ${issue.description ?? ""}`);
      addSignal(map, name, categoryFor(name, issue.description), {
        id: `linear:${issue.id}`,
        source: "linear",
        title: text,
        summary: `${issue.state.name} · ${issue.team.name}${issue.dueDate ? ` · due ${issue.dueDate}` : ""}`,
        occurredAt: issue.updatedAt,
        url: issue.url,
        strength: issue.priority <= 2 ? 4 : 2,
        platform: "Linear",
      }, {
        priority: issue.priority === 1 ? "critical" : issue.priority === 2 ? "high" : "medium",
        blocker: blocked,
        action: true,
        risk: blocked ? text : undefined,
      });
    }
  }

  for (const action of actions.filter((a) => a.status !== "done")) {
    const candidates = projectNamesFromText(action.text);
    for (const name of candidates) {
      const blocked = looksBlocked(action.text) || !!action.decisionRequired;
      addSignal(map, name, categoryFor(name, action.text), {
        id: `action:${action.id}`,
        source: "action",
        title: action.text,
        summary: `${action.owner}${action.dueDate ? ` · due ${action.dueDate}` : ""}${action.source ? ` · ${action.source}` : ""}`,
        occurredAt: action.updatedAt ?? action.createdAt,
        strength: action.priority === "high" ? 4 : 2,
      }, {
        priority: action.priority === "high" ? "high" : "medium",
        action: true,
        blocker: blocked,
        risk: blocked ? action.text : undefined,
      });
    }
  }

  for (const decision of decisions.filter((d) => d.status !== "superseded")) {
    const candidates = projectNamesFromText(`${decision.title ?? ""} ${decision.text} ${decision.context ?? ""}`);
    for (const name of candidates) {
      addSignal(map, name, categoryFor(name, decision.text), {
        id: `decision:${decision.id}`,
        source: "decision",
        title: decision.title ?? decision.text.slice(0, 80),
        summary: decision.summary ?? decision.text,
        occurredAt: decision.updatedAt ?? decision.createdAt,
        strength: decision.needsReview ? 2 : 3,
      }, {
        priority: decision.needsReview ? "medium" : "high",
        decision: true,
        risk: decision.needsReview ? `Decision needs review: ${decision.title ?? decision.text.slice(0, 80)}` : undefined,
      });
    }
  }

  for (const memory of memories.filter((m) => m.kind === "context" || m.kind === "fact")) {
    const candidates = projectNamesFromText(`${memory.entity ?? ""} ${memory.content}`, memory.entity);
    for (const name of candidates) {
      addSignal(map, name, categoryFor(name, memory.content), {
        id: `memory:${memory.id}`,
        source: "memory",
        title: memory.entity ?? name,
        summary: memory.content,
        occurredAt: memory.updatedAt,
        strength: memory.kind === "context" ? 3 : 1,
      }, {
        priority: memory.needsReview ? "low" : "medium",
        risk: memory.needsReview ? `Memory needs review: ${memory.content}` : undefined,
      });
    }
  }

  for (const msg of slackMessages) {
    const candidates = projectNamesFromText(`${msg.channel} ${msg.text}`);
    for (const name of candidates) {
      const blocked = looksBlocked(msg.text);
      addSignal(map, name, categoryFor(name, msg.text), {
        id: `slack:${msg.channelId ?? msg.channel}:${msg.id}`,
        source: "slack",
        title: `${msg.channel} · ${msg.author}`,
        summary: msg.text,
        occurredAt: msg.date,
        strength: msg.isMention || blocked || msg.channelId?.startsWith("D") ? 4 : 2,
        platform: "Slack",
      }, {
        priority: msg.isMention || blocked ? "high" : "medium",
        blocker: blocked,
        risk: blocked ? `${msg.channel}: ${msg.text}` : undefined,
      });
    }
  }

  const projects = Array.from(map.values())
    .map(summariseProject)
    .sort((a, b) => {
      const priorityDiff = priorityRank(a.priority) - priorityRank(b.priority);
      if (priorityDiff !== 0) return priorityDiff;
      const sourceDiff = Object.keys(b.sourceBreakdown).length - Object.keys(a.sourceBreakdown).length;
      if (sourceDiff !== 0) return sourceDiff;
      return new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime();
    })
    .slice(0, 30);

  return {
    generatedAt: new Date().toISOString(),
    projects,
    sourceCounts: {
      slack: slackMessages.length,
      linear: linearIssues.length,
      actions: actions.filter((a) => a.status !== "done").length,
      decisions: decisions.filter((d) => d.status !== "superseded").length,
      memories: memories.length,
      aiProjects: aiProjectsData.projects?.filter((p) => !p.hidden).length ?? 0,
      manual: manualProjects.length,
    },
  };
}

export function formatProjectRadar(projects: CanonicalProject[]): string {
  if (projects.length === 0) {
    return "No active projects detected from connected sources.";
  }

  return projects
    .slice(0, 8)
    .map((p, idx) => {
      const sources = Object.entries(p.sourceBreakdown)
        .map(([source, count]) => `${source}:${count}`)
        .join(", ");
      const risks = p.riskNotes.length ? `\n  Risks: ${p.riskNotes.slice(0, 2).join(" | ")}` : "";
      return `${idx + 1}. ${p.name} — ${p.status}, ${p.priority}. ${p.summary}. Sources: ${sources}. Next: ${p.nextBestAction}${risks}`;
    })
    .join("\n");
}
