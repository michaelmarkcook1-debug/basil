import "server-only";

import { getTodayEvents } from "@/lib/google/calendar";
import { getRecentEmails } from "@/lib/google/gmail";
import { listActions } from "@/lib/actions/store";
import { listDecisions } from "@/lib/decisions/store";
import { listMemories } from "@/lib/memory/store";
import { buildProjectTruth, formatProjectRadar } from "@/lib/projects/truth";
import { getSettings } from "@/lib/settings/store";
import { buildSlackCommandCentre, formatSlackCommandCentre } from "@/lib/stig/slack-command";
import { readProjectsStore } from "@/lib/ai-projects/store";
import { readStore } from "@/lib/storage/persistent";
import type { SignalIndex } from "@/lib/whatsapp/dump-job";
import type { StigContextBundle, StigSourceStatus } from "@/lib/stig/types";
import { SOURCE_CAPS, WORKSPACE_CONTEXT_BUDGET, truncateSectionsTobudget, type ContextSection } from "@/lib/stig/budget";

async function capture<T>(
  source: string,
  fn: () => Promise<T>,
  count: (value: T) => number
): Promise<{ value: T | null; status: StigSourceStatus }> {
  try {
    const value = await fn();
    const n = count(value);
    return { value, status: { source, status: n > 0 ? "ok" : "empty", count: n } };
  } catch (err) {
    return {
      value: null,
      status: {
        source,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// Inline constants from dump-job.ts (not exported from that module).
const WA_SIGNAL_INDEX_FILE = "whatsapp-signal-index.json";
function waUserSubdir(username: string): string {
  return `users/${username.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
}

/** 90 days in milliseconds — max age of a WhatsApp signal index to be included. */
const WA_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Read the WhatsApp signal index for a user and return a compact summary string.
 * Returns null if the index is absent or too old (>90 days).
 */
async function readWhatsAppSummary(username: string): Promise<string | null> {
  try {
    const index = await readStore<SignalIndex | null>(WA_SIGNAL_INDEX_FILE, null, waUserSubdir(username));
    if (!index) return null;
    const age = Date.now() - new Date(index.capturedAt).getTime();
    if (age > WA_MAX_AGE_MS) return null;

    const topContacts = index.chats
      .slice(0, 10)
      .map((c) => c.name)
      .join(", ");
    const capturedDate = index.capturedAt.slice(0, 10);

    return [
      `## WhatsApp contacts (${index.chats.length} contacts)`,
      `Last imported: ${capturedDate}`,
      `Key contacts: ${topContacts || "none"}`,
    ].join("\n");
  } catch {
    return null;
  }
}

export async function buildStigContext(username: string, timezone?: string): Promise<StigContextBundle> {
  const settings = await getSettings(username);
  const tz = timezone || settings.timezone || "Europe/London";

  const [
    calendarRes,
    emailRes,
    slackRes,
    actionsRes,
    decisionsRes,
    memoriesRes,
    projectsRes,
    aiProjectsRes,
  ] = await Promise.all([
    capture("calendar", () => getTodayEvents(username, tz), (v) => v.length),
    capture("gmail", () => getRecentEmails(username, SOURCE_CAPS.emails, 3), (v) => v.length),
    capture("slack", () => buildSlackCommandCentre(username, SOURCE_CAPS.slack), (v) => v.totalMessages),
    capture("actions", () => listActions(username), (v) => v.length),
    capture("decisions", () => listDecisions(username), (v) => v.length),
    capture("memory", () => listMemories(username), (v) => v.length),
    capture("projects", () => buildProjectTruth(username), (v) => v.projects.length),
    capture("ai-work", () => readProjectsStore(username).then((d) => d.projects.filter((p) => !p.hidden)), (v) => v.length),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    timezone: tz,
    sources: [
      calendarRes.status,
      emailRes.status,
      slackRes.status,
      actionsRes.status,
      decisionsRes.status,
      memoriesRes.status,
      projectsRes.status,
      aiProjectsRes.status,
    ],
    calendar: calendarRes.value ?? [],
    emails: emailRes.value ?? [],
    slackCommand: slackRes.value,
    actions: actionsRes.value ?? [],
    decisions: decisionsRes.value ?? [],
    memories: memoriesRes.value ?? [],
    projectTruth: projectsRes.value,
    aiProjects: aiProjectsRes.value ?? [],
    whatsAppSummary: await readWhatsAppSummary(username),
  };
}

function formatCalendar(bundle: StigContextBundle): string {
  if (bundle.calendar.length === 0) return "## Calendar\nNo signal.";
  return "## Calendar\n" + bundle.calendar.slice(0, SOURCE_CAPS.calendar).map((e) => {
    const attendees = e.attendees.length ? ` · with ${e.attendees.slice(0, 5).join(", ")}` : "";
    return `- ${e.start} → ${e.end}: ${e.summary}${attendees}${e.hasVideo ? " · video" : ""}`;
  }).join("\n");
}

function formatEmails(bundle: StigContextBundle): string {
  if (bundle.emails.length === 0) return "## Gmail\nNo signal.";
  return "## Gmail\n" + bundle.emails.slice(0, SOURCE_CAPS.emails).map((e) => {
    return `- ${e.date} · ${e.unread ? "UNREAD · " : ""}${e.from}: ${e.subject}\n  ${e.snippet.slice(0, 220)}`;
  }).join("\n");
}

function formatActions(bundle: StigContextBundle): string {
  const open = bundle.actions.filter((a) => a.status !== "done").slice(0, SOURCE_CAPS.actions);
  if (open.length === 0) return "## Open actions\nNo signal.";
  return "## Open actions\n" + open.map((a) => {
    return `- [${a.priority ?? "medium"}] ${a.text} · owner: ${a.owner ?? "unknown"}${a.dueDate ? ` · due ${a.dueDate}` : ""} · source: ${a.source}`;
  }).join("\n");
}

function formatDecisions(bundle: StigContextBundle): string {
  const active = bundle.decisions.filter((d) => d.status !== "superseded").slice(0, SOURCE_CAPS.decisions);
  if (active.length === 0) return "## Active decisions\nNo signal.";
  return "## Active decisions\n" + active.map((d) => {
    return `- ${d.title ?? d.text.slice(0, 80)} · ${d.date} · ${d.text}${d.consequences?.length ? ` · consequences: ${d.consequences.join("; ")}` : ""}`;
  }).join("\n");
}

function formatMemory(bundle: StigContextBundle): string {
  if (bundle.memories.length === 0) return "## Relevant memory\nNo signal.";
  return "## Relevant memory\n" + bundle.memories.slice(0, SOURCE_CAPS.memory).map((m) => {
    return `- ${m.kind}${m.entity ? ` · ${m.entity}` : ""}: ${m.content}`;
  }).join("\n");
}

function formatSources(bundle: StigContextBundle): string {
  return "## Source status\n" + bundle.sources.map((s) => {
    const count = typeof s.count === "number" ? ` (${s.count})` : "";
    return `- ${s.source}: ${s.status}${count}${s.error ? ` — ${s.error}` : ""}`;
  }).join("\n");
}

function formatAIWork(bundle: StigContextBundle): string {
  const items = bundle.aiProjects.filter((p) => !p.hidden).slice(0, SOURCE_CAPS.aiProjects);
  if (items.length === 0) return "## AI work\nNo signal.";
  return "## AI work\n" + items.map((p) => {
    const review = p.importance === "critical" || p.importance === "high" ? " · NEEDS REVIEW" : "";
    return `- [${p.platform}] ${p.name}: ${p.summary}${review} · last active ${p.lastActiveAt.slice(0, 10)}`;
  }).join("\n");
}

export function formatStigContext(bundle: StigContextBundle): string {
  const projectRadar = bundle.projectTruth
    ? `## Project radar\n${formatProjectRadar(bundle.projectTruth.projects)}`
    : "## Project radar\nNo signal.";

  const parts = [
    `# Basil/Stig live source pack`,
    `Generated: ${bundle.generatedAt}`,
    `Timezone: ${bundle.timezone}`,
    formatSources(bundle),
    bundle.slackCommand ? formatSlackCommandCentre(bundle.slackCommand) : "## Slack Command Centre\nNo signal.",
    projectRadar,
    formatCalendar(bundle),
    formatEmails(bundle),
    formatActions(bundle),
    formatDecisions(bundle),
    formatMemory(bundle),
    formatAIWork(bundle),
  ];

  if (bundle.whatsAppSummary) {
    parts.push(bundle.whatsAppSummary);
  }

  return parts.join("\n\n");
}

/**
 * Like formatStigContext but truncates output to fit within tokenBudget.
 * Higher-priority sections (Slack, actions, decisions) are preserved; lower-priority
 * sections (memory, AI work, WhatsApp) are truncated or dropped first.
 */
export function formatStigContextBudgeted(
  bundle: StigContextBundle,
  tokenBudget: number = WORKSPACE_CONTEXT_BUDGET
): string {
  const projectRadar = bundle.projectTruth
    ? `## Project radar\n${formatProjectRadar(bundle.projectTruth.projects)}`
    : "## Project radar\nNo signal.";

  const header = [
    `# Basil/Stig live source pack`,
    `Generated: ${bundle.generatedAt}`,
    `Timezone: ${bundle.timezone}`,
    formatSources(bundle),
  ].join("\n\n");

  const sections: ContextSection[] = [
    { label: "header", content: header, priority: 0 },
    {
      label: "slack",
      content: bundle.slackCommand
        ? formatSlackCommandCentre(bundle.slackCommand)
        : "## Slack Command Centre\nNo signal.",
      priority: 1,
    },
    { label: "actions", content: formatActions(bundle), priority: 2 },
    { label: "decisions", content: formatDecisions(bundle), priority: 3 },
    { label: "calendar", content: formatCalendar(bundle), priority: 4 },
    { label: "project-radar", content: projectRadar, priority: 5 },
    { label: "emails", content: formatEmails(bundle), priority: 6 },
    { label: "ai-work", content: formatAIWork(bundle), priority: 7 },
    { label: "memory", content: formatMemory(bundle), priority: 8 },
  ];

  if (bundle.whatsAppSummary) {
    sections.push({ label: "whatsapp", content: bundle.whatsAppSummary, priority: 9 });
  }

  return truncateSectionsTobudget(sections, tokenBudget);
}
