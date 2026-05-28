export const maxDuration = 300;

/**
 * Daily briefing generator — v2.
 *
 * Intelligence-centric output (not source-centric):
 *   criticalToday       — top urgent items, cross-source
 *   followUps           — email replies + stalled actions + decision consequences
 *   decisionsToWatch    — recent decisions with open follow-ups
 *   meetingsNeedingPrep — today's video meetings with context + prep gaps
 *   peopleAndAccounts   — cross-source relationship signals
 *   inboxSlack          — remaining inbox/Slack highlights
 *
 * Data priority: structured stores (actions, decisions, memory) first;
 * raw source text (email, Slack, Zoom) as supporting evidence.
 */

import { generateText, type ModelMessage } from "ai";
import { getTextModel, MAX_TOKENS } from "@/lib/ai/model-config";
import { getSystemPrompt } from "@/lib/ai/system-prompt";
import { parseAndValidate } from "@/lib/ai/parse-json";
import { BriefingOutputSchema } from "@/lib/ai/schemas";
import { getSettings } from "@/lib/settings/store";
import { getTodayEvents, type CalendarEvent } from "@/lib/google/calendar";
import { getRecentEmails, type GmailMessage } from "@/lib/google/gmail";
import {
  getRecentSlackMessages,
  type SlackMessage,
} from "@/lib/slack/client";
import { getSessionUser } from "@/lib/auth";
import { getUsers, isAdminUser } from "@/lib/users";
import { listActions, isActionStalled } from "@/lib/actions/store";
import { listDecisions } from "@/lib/decisions/store";
import { getZoomSummariesFromGmail } from "@/lib/google/zoom-summaries";
import type { ZoomSummary } from "@/lib/google/zoom-summaries";
import { getReadSummariesFromGmail } from "@/lib/google/read-summaries";
import type { ReadSummary } from "@/lib/google/read-summaries";
import { listMemories } from "@/lib/memory/store";
import type { Memory } from "@/lib/memory/types";
import {
  parseExtraContext,
  formatExtraContextBlock,
  type ExtraContext,
} from "@/lib/ai/extra-context";
import {
  readGenerateCache,
  writeGenerateCache,
  deleteGenerateCache,
  isCacheValid,
  computeInputHash,
  BRIEFING_TTL_MS,
} from "@/lib/generate-cache/store";
import type { Briefing } from "@/lib/types/briefing";
import { buildProjectTruth, formatProjectRadar } from "@/lib/projects/truth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

const GEN_BRIEFING_RATE_LIMIT = 5; // Briefings are expensive — 5 per minute per IP

// ── GET — return today's cached briefing ────────────────────────────────────
export async function GET() {
  const username = await getSessionUser();
  if (!username) return Response.json({ error: "Unauthorised" }, { status: 401 });

  const record = await readGenerateCache<Briefing>(username, "briefing");
  if (!record || !isCacheValid(record)) return Response.json(null);

  return Response.json(record.content);
}

// ── DELETE — invalidate cached briefing (force-regenerate on next POST) ─────
export async function DELETE(req: Request) {
  // Cron callers (generate-briefing cron pre-clears the cache) use CRON_SECRET.
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  const isCronCall = cronSecret && authHeader === `Bearer ${cronSecret}`;

  let username: string | null = null;
  if (isCronCall) {
    const users = await getUsers();
    const adminUser = users.find((u) => isAdminUser(u.username)) ?? users[0];
    username = adminUser?.username ?? null;
  } else {
    username = await getSessionUser();
  }
  if (!username) return Response.json({ error: "Unauthorised" }, { status: 401 });

  await deleteGenerateCache(username, "briefing");
  return Response.json({ ok: true });
}

// ── Format helpers ─────────────────────────────────────────────────────────────

function fmtTime(iso: string, tz = "Europe/London"): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatCalendarBlock(events: CalendarEvent[], tz = "Europe/London"): string {
  if (events.length === 0) return "No events on today's calendar.";
  return events
    .map((e) => {
      const time = e.isAllDay ? "All day" : `${fmtTime(e.start, tz)} – ${fmtTime(e.end, tz)}`;
      const video = e.hasVideo ? " [VIDEO]" : "";
      const attendees = e.attendees.length
        ? ` — with ${e.attendees.slice(0, 5).join(", ")}`
        : "";
      return `- ${time} | ${e.summary}${video}${attendees}`;
    })
    .join("\n");
}

function formatEmailBlock(emails: GmailMessage[], snippetLen = 160, tz = "Europe/London"): string {
  if (emails.length === 0) return "";
  return emails
    .map((e) => {
      const date = new Date(e.date).toLocaleString("en-GB", {
        timeZone: tz,
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
      const snippet =
        e.snippet.length > snippetLen
          ? e.snippet.slice(0, snippetLen) + "…"
          : e.snippet;
      return `- [${date}] From: ${e.from} | "${e.subject}"\n  ${snippet}`;
    })
    .join("\n");
}

function formatSlackBlock(messages: SlackMessage[]): string {
  if (messages.length === 0) return "";
  return messages
    .map((m) => {
      const isDM = !!m.channelId?.startsWith("D");
      const mention = m.isMention ? " [@MENTION]" : "";
      const dm = isDM ? " [DM]" : "";
      const text =
        m.text.length > 200 ? m.text.slice(0, 200) + "…" : m.text;
      return `- ${m.channel}${dm}${mention} | ${m.author}: ${text}`;
    })
    .join("\n");
}

function formatZoomBlock(summaries: ZoomSummary[], tz = "Europe/London"): string {
  if (summaries.length === 0) return "";
  return summaries
    .map((s) => {
      const date = new Date(s.date).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        timeZone: tz,
      });
      const body = s.body.length > 350 ? s.body.slice(0, 350) + "…" : s.body;
      return `- [${date}] ${s.title}\n  ${body}`;
    })
    .join("\n");
}

function formatReadBlock(summaries: ReadSummary[], tz = "Europe/London"): string {
  if (summaries.length === 0) return "";
  return summaries
    .map((s) => {
      const date = new Date(s.date).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        timeZone: tz,
      });
      const body = s.body.length > 350 ? s.body.slice(0, 350) + "…" : s.body;
      return `- [${date}] ${s.title}\n  ${body}`;
    })
    .join("\n");
}

// ── Route ──────────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  // Cron callers authenticate with CRON_SECRET; browser callers use session cookie.
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  const isCronCall = cronSecret && authHeader === `Bearer ${cronSecret}`;

  let username: string | null = null;
  if (isCronCall) {
    const users = await getUsers();
    const adminUser = users.find((u) => isAdminUser(u.username)) ?? users[0];
    username = adminUser?.username ?? null;
    if (!username) return Response.json({ error: "No users configured" }, { status: 503 });
  } else {
    username = await getSessionUser();
    if (!username) return Response.json({ error: "Unauthorised" }, { status: 401 });

    // Rate-limit browser-initiated regenerations only (cron calls bypass this)
    const ip = getClientIp(req);
    const rl = checkRateLimit(`gen:briefing:${ip}`, GEN_BRIEFING_RATE_LIMIT);
    if (!rl.allowed) {
      return Response.json(
        { error: "Too many requests — slow down" },
        { status: 429, headers: { "Retry-After": String(rl.retryAfter) } }
      );
    }
  }

  const settings  = await getSettings(username).catch(() => null); // ci-ok: settings optional, null falls back to defaults
  const tz        = settings?.timezone || "Europe/London";

  const today = new Date().toLocaleDateString("en-GB", {
    timeZone: tz,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  // Derive today's date string in the user's timezone (avoids UTC midnight drift)
  const todayDate = new Date().toLocaleDateString("en-CA", { timeZone: tz });

  // Accept multipart FormData (extra context) or no body (simple trigger).
  let extra: ExtraContext = {
    notes: "",
    textBlock: "",
    fileParts: [],
    skipped: [],
    summary: "no extra context",
  };
  type BriefingType = "morning" | "midday" | "evening" | "weekly" | "meeting";
  let briefingType: BriefingType = "morning";
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    try {
      const form = await req.formData();
      extra = await parseExtraContext(form);
      const rawType = form.get("briefingType");
      if (rawType && ["morning","midday","evening","weekly","meeting"].includes(String(rawType))) {
        briefingType = String(rawType) as BriefingType;
      }
    } catch (e) {
      console.error("Failed to parse extra context:", e);
    }
  }

  // ── Parallel fetch all sources ────────────────────────────────────────────
  const [
    calendarResult,
    emailResult,
    slackResult,
    actionsResult,
    decisionsResult,
    zoomResult,
    readResult,
    memoriesResult,
    projectTruthResult,
  ] = await Promise.all([
    getTodayEvents(username, tz).catch((err) => {
      console.error("Calendar fetch failed:", err);
      return null;
    }),
    // 20 emails gives enough signal to split unread / read meaningfully
    getRecentEmails(username, 20).catch((err) => {
      console.error("Email fetch failed:", err);
      return null;
    }),
    // 25 messages — DMs and @mentions surfaced first inside the block
    getRecentSlackMessages(username, 25).catch((err) => {
      console.error("Slack fetch failed:", err);
      return null;
    }),
    listActions(username).catch((err) => {
      console.error("Actions fetch failed:", err);
      return [];
    }),
    listDecisions(username).catch((err) => {
      console.error("Decisions fetch failed:", err);
      return [];
    }),
    // 8 summaries from the last 7 days — richer Zoom context for today's attendees
    getZoomSummariesFromGmail(username, 7, 8).catch((err) => {
      console.error("Zoom summaries fetch failed:", err);
      return [];
    }),
    // 6 Read.ai meeting recaps from the last 7 days
    getReadSummariesFromGmail(username, 7, 6).catch((err) => {
      console.error("Read.ai summaries fetch failed:", err);
      return [] as ReadSummary[];
    }),
    listMemories(username).catch((err) => {
      console.error("Memories fetch failed:", err);
      return [] as Memory[];
    }),
    buildProjectTruth(username).catch((err) => {
      console.error("Project truth fetch failed:", err);
      return null;
    }),
  ]);

  // ── Calendar ─────────────────────────────────────────────────────────────
  const calendarBlock =
    calendarResult === null
      ? "Google Calendar not connected."
      : formatCalendarBlock(calendarResult, tz);

  // ── Emails — unread (full snippet) vs recently-read ──────────────────────
  const emails = emailResult ?? [];
  const unreadEmails = emails.filter((e) => e.unread);
  const readEmails = emails.filter((e) => !e.unread).slice(0, 8);

  const emailBlock =
    emailResult === null
      ? "Gmail not connected."
      : emails.length === 0
        ? "Inbox is quiet — no recent emails."
        : [
            unreadEmails.length > 0
              ? `UNREAD (${unreadEmails.length}):\n${formatEmailBlock(unreadEmails, 200, tz)}`
              : "No unread emails.",
            readEmails.length > 0
              ? `\nRECENTLY READ:\n${formatEmailBlock(readEmails, 120, tz)}`
              : "",
          ]
            .filter(Boolean)
            .join("\n");

  // ── Slack — DMs and @mentions prominently, channel activity second ────────
  const slackMessages = slackResult ?? [];
  const dmsMentions = slackMessages.filter(
    (m) => m.isMention || m.channelId?.startsWith("D")
  );
  const channelActivity = slackMessages
    .filter((m) => !m.isMention && !m.channelId?.startsWith("D"))
    .slice(0, 12);

  const slackBlock =
    slackResult === null
      ? "Slack not connected."
      : slackMessages.length === 0
        ? "No recent Slack activity."
        : [
            dmsMentions.length > 0
              ? `DMs & MENTIONS:\n${formatSlackBlock(dmsMentions)}`
              : "",
            channelActivity.length > 0
              ? `\nCHANNEL ACTIVITY:\n${formatSlackBlock(channelActivity)}`
              : "",
          ]
            .filter(Boolean)
            .join("\n");

  // ── Zoom summaries ────────────────────────────────────────────────────────
  const zoomBlock = zoomResult.length > 0 ? formatZoomBlock(zoomResult, tz) : "";

  // ── Read.ai summaries ─────────────────────────────────────────────────────
  const readBlock = readResult.length > 0 ? formatReadBlock(readResult, tz) : "";

  // ── Actions — three buckets by urgency ───────────────────────────────────
  const openActions = actionsResult.filter((a) => a.status !== "done");
  const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

  // Bucket 1: Overdue + due today — hardest deadline pressure
  const urgentActions = openActions
    .filter((a) => {
      const isOverdue =
        a.status === "overdue" ||
        (a.status === "open" && a.dueDate && a.dueDate < todayDate);
      const isDueToday = a.status === "open" && a.dueDate === todayDate;
      return isOverdue || isDueToday;
    })
    .sort(
      (a, b) =>
        (PRIORITY_ORDER[a.priority ?? "low"] ?? 2) -
        (PRIORITY_ORDER[b.priority ?? "low"] ?? 2)
    );

  // Bucket 2: Stalled — open, undated, no meaningful activity in ≥14 days
  const stalledActions = openActions.filter(isActionStalled);

  // Bucket 3: Other open — high-priority or has a due date, not in above buckets
  const urgentOrStalledIds = new Set(
    [...urgentActions, ...stalledActions].map((a) => a.id)
  );
  const otherOpenActions = openActions
    .filter(
      (a) =>
        !urgentOrStalledIds.has(a.id) &&
        (a.priority === "high" || !!a.dueDate)
    )
    .sort(
      (a, b) =>
        (PRIORITY_ORDER[a.priority ?? "low"] ?? 2) -
        (PRIORITY_ORDER[b.priority ?? "low"] ?? 2)
    )
    .slice(0, 8);

  type ActionLike = (typeof openActions)[number];

  function fmtAction(a: ActionLike): string {
    const isOverdue =
      a.status === "overdue" ||
      (a.status === "open" && a.dueDate && a.dueDate < todayDate);
    const isDueToday = a.status === "open" && a.dueDate === todayDate;
    const flags: string[] = [];
    if (isOverdue) flags.push("OVERDUE");
    else if (isDueToday) flags.push("DUE TODAY");
    else if (a.dueDate) flags.push(`due ${a.dueDate}`);
    if (a.priority === "high") flags.push("HIGH PRIORITY");
    if (isActionStalled(a)) flags.push("STALLED");
    if (a.owner && a.owner !== (settings?.name ?? username)) flags.push(`owner: ${a.owner}`);
    if (a.source && a.source !== "manual") flags.push(a.source);
    if (a.needsReview) flags.push("UNCONFIRMED — awaiting review");
    return `- ${a.text}${flags.length ? ` (${flags.join(", ")})` : ""}`;
  }

  const urgentActionsBlock =
    urgentActions.length === 0
      ? "No overdue or due-today actions."
      : urgentActions.slice(0, 10).map(fmtAction).join("\n");

  const stalledActionsBlock =
    stalledActions.length > 0
      ? stalledActions.slice(0, 8).map(fmtAction).join("\n")
      : "";

  const otherActionsBlock =
    otherOpenActions.length > 0
      ? otherOpenActions.map(fmtAction).join("\n")
      : "";

  // ── Decisions — active, last 14 days ────────────────────────────────────
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const activeDecisions = decisionsResult
    .filter(
      (d) =>
        d.status !== "superseded" &&
        (!d.date || new Date(d.date) >= fourteenDaysAgo)
    )
    .sort(
      (a, b) =>
        new Date(b.updatedAt ?? b.date ?? "").getTime() -
        new Date(a.updatedAt ?? a.date ?? "").getTime()
    )
    .slice(0, 10);

  const decisionsBlock =
    activeDecisions.length === 0
      ? "No decisions logged in the last 14 days."
      : activeDecisions
          .map((d) => {
            const reviewFlag = d.needsReview ? "[UNCONFIRMED] " : "";
            const headline = d.title ? `${d.title}: ${d.text}` : d.text;
            const meta: string[] = [];
            if (d.decidedBy) meta.push(d.decidedBy);
            if (d.date) meta.push(d.date);
            if (d.source) meta.push(`via ${d.source}`);
            const metaStr = meta.length > 0 ? ` (${meta.join(", ")})` : "";
            const rationaleStr = d.rationale ? `\n  Why: ${d.rationale}` : "";
            const consequencesStr =
              d.consequences && d.consequences.length > 0
                ? `\n  Pending follow-ups: ${d.consequences.join("; ")}`
                : "";
            return `- ${reviewFlag}${headline}${metaStr}${rationaleStr}${consequencesStr}`;
          })
          .join("\n");

  // ── Relationship memory — person/context/fact notes, last 30 days ─────────
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recentMemories = (memoriesResult as Memory[])
    .filter((m) => new Date(m.updatedAt).getTime() > thirtyDaysAgo)
    .slice(0, 15);

  const memoryBlock =
    recentMemories.length > 0
      ? recentMemories
          .map(
            (m) =>
              `- [${m.kind}${m.entity ? ` · ${m.entity}` : ""}] ${m.content}`
          )
          .join("\n")
      : "";

  const projectRadarBlock = projectTruthResult
    ? formatProjectRadar(projectTruthResult.projects)
    : "Project Truth Layer unavailable.";

  const extraBlock = formatExtraContextBlock(extra);

  // ── Signal density (for LOW SIGNAL discipline) ─────────────────────────
  const totalSignal =
    (calendarResult?.length ?? 0) +
    emails.length +
    slackMessages.length +
    zoomResult.length +
    readResult.length;

  // ── Source readiness — explicit connection/availability for AI context ──
  const googleConnected = calendarResult !== null || emailResult !== null;
  const slackConnected  = slackResult !== null;

  const sourceReadiness = {
    calendar: {
      connected:  calendarResult !== null,
      eventCount: calendarResult?.length ?? 0,
      status:     calendarResult === null ? "not_connected" : calendarResult.length === 0 ? "empty" : "ok",
    },
    gmail: {
      connected:  emailResult !== null,
      emailCount: emails.length,
      status:     emailResult === null ? "not_connected" : emails.length === 0 ? "empty" : "ok",
    },
    slack: {
      connected:    slackResult !== null,
      messageCount: slackMessages.length,
      status:       slackResult === null ? "not_connected" : slackMessages.length === 0 ? "empty" : "ok",
    },
    zoom: {
      connected:    emailResult !== null, // Zoom summaries come from Gmail
      summaryCount: zoomResult.length,
      status:       emailResult === null ? "not_connected" : zoomResult.length === 0 ? "empty" : "ok",
    },
    read: {
      connected:    emailResult !== null, // Read.ai summaries come from Gmail
      summaryCount: readResult.length,
      status:       emailResult === null ? "not_connected" : readResult.length === 0 ? "empty" : "ok",
    },
    actions: {
      connected: true,
      count:     openActions.length,
      status:    "ok" as const,
    },
    decisions: {
      connected: true,
      count:     activeDecisions.length,
      status:    "ok" as const,
    },
    memory: {
      connected: true,
      count:     recentMemories.length,
      status:    "ok" as const,
    },
    projects: {
      connected: true,
      count:     projectTruthResult?.projects.length ?? 0,
      status:    projectTruthResult ? "ok" : "error",
    },
  };

  // ── Source attribution — human-readable for the briefing footer ─────────
  const connectedSources: string[] = [];
  const unavailableSources: string[] = [];

  if (sourceReadiness.calendar.status === "ok")
    connectedSources.push(`Calendar (${sourceReadiness.calendar.eventCount} event${sourceReadiness.calendar.eventCount !== 1 ? "s" : ""})`);
  else if (sourceReadiness.calendar.status === "empty")
    connectedSources.push("Calendar (no events today)");
  else
    unavailableSources.push("Google Calendar (not connected)");

  if (sourceReadiness.gmail.status === "ok")
    connectedSources.push(`Gmail (${sourceReadiness.gmail.emailCount} email${sourceReadiness.gmail.emailCount !== 1 ? "s" : ""})`);
  else if (sourceReadiness.gmail.status === "empty")
    connectedSources.push("Gmail (inbox quiet)");
  else
    unavailableSources.push("Gmail (not connected)");

  if (sourceReadiness.slack.status === "ok")
    connectedSources.push(`Slack (${sourceReadiness.slack.messageCount} message${sourceReadiness.slack.messageCount !== 1 ? "s" : ""})`);
  else if (sourceReadiness.slack.status === "empty")
    connectedSources.push("Slack (no recent activity)");
  else
    unavailableSources.push("Slack (not connected)");

  if (sourceReadiness.zoom.status === "ok" && zoomResult.length > 0)
    connectedSources.push(`Zoom summaries (${zoomResult.length})`);

  if (sourceReadiness.read.status === "ok" && readResult.length > 0)
    connectedSources.push(`Read.ai summaries (${readResult.length})`);

  if (openActions.length > 0)
    connectedSources.push(`Actions (${openActions.length} open)`);
  if (activeDecisions.length > 0)
    connectedSources.push(`Decisions (${activeDecisions.length} active)`);
  if (recentMemories.length > 0)
    connectedSources.push(`Memory (${recentMemories.length} notes)`);
  if ((projectTruthResult?.projects.length ?? 0) > 0)
    connectedSources.push(`Projects (${projectTruthResult!.projects.length})`);

  // ── Manual-only mode — all external sources disconnected ───────────────
  const allExternalMissing = !googleConnected && !slackConnected;
  const hasManualData =
    openActions.length > 0 ||
    activeDecisions.length > 0 ||
    recentMemories.length > 0 ||
    (projectTruthResult?.projects.length ?? 0) > 0;

  // ── Build prompt ──────────────────────────────────────────────────────────
  // ── Zero-integration shortcut — no AI needed if no data exists at all ──
  if (allExternalMissing && !hasManualData) {
    const emptyBriefing: import("@/lib/types/briefing").Briefing = {
      criticalToday:       "No external integrations connected and no manual data found. Connect Google (Calendar + Gmail) and/or Slack via Settings → Integrations, then add actions, decisions, or memory to give Basil something to work with.",
      projectRadar:        null,
      followUps:           null,
      decisionsToWatch:    null,
      meetingsNeedingPrep: null,
      peopleAndAccounts:   null,
      inboxSlack:          null,
      generatedAt:         new Date().toISOString(),
      extraContextSummary: extra.summary,
      dataSources: {
        todayEvents: 0, emails: 0, slackMessages: 0, zoomSummaries: 0, readSummaries: 0,
        openActions: 0, activeDecisions: 0, recentMemories: 0, projects: 0,
        googleConnected: false, slackConnected: false,
      },
      sourceAttribution: { connected: [], unavailable: unavailableSources },
    };
    return Response.json(emptyBriefing);
  }

  const sourceStatusBlock = [
    "## SOURCE STATUS (authoritative — do not speculate beyond this)",
    `Connected: ${connectedSources.length > 0 ? connectedSources.join(", ") : "none"}`,
    unavailableSources.length > 0 ? `Not available: ${unavailableSources.join(", ")}` : "",
    allExternalMissing
      ? "MODE: Manual-only — no external integrations connected. State clearly: 'No external integrations connected. Showing manual data only.' Do not fabricate email, Slack, or calendar content."
      : "",
  ].filter(Boolean).join("\n");

  const BRIEFING_TYPE_FRAMING: Record<BriefingType, string> = {
    morning: `MODE: MORNING BRIEF
Focus: What's ahead today. Prioritise calendar prep, outstanding commitments from yesterday, and anything that needs action before 10am.
Tone: Forward-looking. "Here's what you're walking into."`,
    midday: `MODE: MIDDAY REFRESH
Focus: What's happened so far, what's blocked, and what needs attention this afternoon. De-emphasise morning prep — it's already happened.
Tone: In-flight check-in. "Here's where things stand at midday."
Adjust sections: criticalToday = afternoon priorities only. meetingsNeedingPrep = afternoon meetings only. followUps = what hasn't moved since this morning. projectRadar = what's actively running right now. Skip or minimise anything already handled this morning.`,
    evening: `MODE: EVENING WRAP
Focus: What moved today, what's unresolved, and what to set up for tomorrow.
Tone: Reflective but action-oriented. "Here's what happened and what to do before you close."
Adjust sections: criticalToday = anything unresolved that must not carry overnight. followUps = what needs a note or reply before EOD. meetingsNeedingPrep = tomorrow's first meetings. projectRadar = what advanced today vs what stalled. peopleAndAccounts = who you need to follow up with before tomorrow.`,
    weekly: `MODE: WEEKLY DIGEST
Focus: Cross-week patterns, momentum, and relationship trends — not today's to-dos.
Tone: Zoomed out. "Here's what the week looked like and where the momentum is."
Adjust sections: criticalToday = top 3 priorities for the week ahead. projectRadar = projects that gained momentum vs stalled this week. followUps = relationships or threads that have gone quiet for 5+ days. decisionsToWatch = decisions made this week and their downstream implications. peopleAndAccounts = people who showed up across multiple touchpoints this week — are any relationships drifting? inboxSlack = weekly patterns in inbox and Slack, not individual messages. meetingsNeedingPrep = key meetings in the next 7 days.`,
    meeting: `MODE: MEETING PREP
Focus: Prep for the next significant meeting or first meeting today. Single-meeting depth over breadth.
Tone: Tactical. "Here's everything you need to walk into this meeting sharp."
Adjust sections: meetingsNeedingPrep = the PRIMARY section — go deep on the next meeting: who's attending, what the relationship history is, what's been discussed in email/Slack/Zoom, open actions tied to those people, what outcome to aim for, and any risks to flag. criticalToday = only items that could derail or affect this meeting. All other sections can be brief or null unless they directly relate to meeting attendees.`,
  };

  const firstName = settings?.name?.split(" ")[0] ?? "the user";
  const promptText = `Generate ${firstName}'s ${briefingType} briefing for ${today}.
Goal: 3-minute executive read. Not a log — intelligence. Tell ${firstName} what to do today, who to respond to, what to watch, and what to prepare for.

${BRIEFING_TYPE_FRAMING[briefingType]}

---

${sourceStatusBlock}

---

## SOURCE DATA

### TODAY'S CALENDAR
${calendarBlock}

### PROJECT RADAR — canonical active projects from Slack, Linear, actions, decisions, memory, and AI work
${projectRadarBlock}

### URGENT ACTIONS — overdue or due today (from Action Tracker — real commitments)
${urgentActionsBlock}
${stalledActionsBlock ? `
### STALLED ACTIONS — open, no activity in 14+ days (silently slipping)
${stalledActionsBlock}
` : ""}${otherActionsBlock ? `
### OTHER HIGH-PRIORITY OPEN ACTIONS
${otherActionsBlock}
` : ""}
### DECISION LOG — active decisions from last 14 days (already made — use only for follow-up context)
${decisionsBlock}

### EMAILS — last 48h
${emailBlock}

### SLACK — last 48h
${slackBlock}
${zoomBlock ? `
### ZOOM MEETING SUMMARIES — last 7 days (AI Companion recaps — what was actually said on prior calls)
${zoomBlock}
` : ""}${readBlock ? `
### READ.AI MEETING SUMMARIES — last 7 days (Read Assistant recaps — action items, key topics, and what was said)
${readBlock}
` : ""}${memoryBlock ? `
### RELATIONSHIP MEMORY — person/context notes accumulated over prior interactions
${memoryBlock}
` : ""}${extraBlock ? `\n${extraBlock}\n` : ""}---

## Briefing structure

Write the way a great chief of staff would: opinionated, specific, cross-referenced. Michael scans this before his day begins.

**criticalToday** — 3-5 items that genuinely need attention today. Cross-source: if an overdue action also appears in an email thread, that is ONE item not two. If an attendee also sent a DM, that is ONE item. Rank by real urgency — not by which source listed it first. If there is nothing critical today, say so honestly ("Routine day — nothing critical.").

**projectRadar** — active projects that need executive attention today. Prioritise blocked projects, projects with multi-source signal, AI work needing review, and projects with open decisions/actions. This is the “what am I actually working on?” section.

**followUps** — things requiring Michael's active response: email replies he hasn't sent, stalled actions that need a nudge, decision consequences that haven't been confirmed yet. For each: one line on what it is, one line on why it matters now. Name the person specifically.

**decisionsToWatch** — recent decisions from the Decision Log that have pending follow-up consequences listed. Flag if a consequence appears not yet actioned (don't claim it hasn't been — just flag it as worth checking). Also surface any genuinely new decisions implied by today's calendar or inbox (not fabricated — only if clearly implied by live data). Do NOT re-list already-made decisions as open items.

**meetingsNeedingPrep** — today's video/multi-attendee calendar meetings worth preparing for. For each: name + time, what the current context is (from email/Slack/Zoom summaries/Read.ai recaps mentioning those attendees), what Michael should aim to land. If signal is thin, flag it ("No recent signal on this one — go in open"). Skip solo blocks and trivial quick syncs unless context makes them significant.

**peopleAndAccounts** — people or accounts appearing across multiple sources today (e.g. "Ed in 3pm meeting + unread email + Slack DM — three touchpoints suggesting something's live"), or where relationship memory or a recent Zoom note suggests a check-in is overdue. Specific and grounded. Null if no genuine cross-source signals.

**inboxSlack** — remaining inbox and Slack highlights not already covered above. Only what merits Michael's attention. Skip newsletters, Zoom join/confirmation emails, OOO replies, auto-notifications, and anything already surfaced in criticalToday or followUps.

---

## Factual guardrails — non-negotiable

Every name, company, email subject, Slack quote, action text, decision, and commitment must come from the SOURCE DATA above.
- Do NOT fabricate names, deal stages, company names, dollar figures, or product outcomes not present in the data.
- If a source is disconnected, say "Not connected" and move on.
- If connected but empty, say so briefly ("Inbox quiet", "No Slack signal") in the relevant section.
- Zoom summaries and Read.ai recaps contain what was ACTUALLY SAID on prior calls — cross-reference their attendees with today's calendar for meetingsNeedingPrep.
- DECISION LOG entries are already-made decisions. Only surface them as "this decision has pending follow-ups" — never as "this still needs to be decided".
- Relationship memory notes are accumulated facts about people — use them to enrich peopleAndAccounts and meetingsNeedingPrep. Never invent claims beyond what the memory says.
- PROJECT RADAR is a source-attributed heuristic. Use it to explain active projects, but do not claim a project is blocked unless a listed risk/blocker says so.
- Signal density today: ${totalSignal} live source item(s)${recentMemories.length > 0 ? ` + ${recentMemories.length} memory note(s)` : ""}. If signal is low, produce a shorter briefing — an honest 2-item brief beats a padded fabrication.
- Items marked [UNCONFIRMED] or "UNCONFIRMED — awaiting review" are candidates Basil identified from signals but Michael has not yet verified. Present these as tentative ("may have been decided", "worth checking", "appears to") — never as confirmed facts or firm commitments.
${extraBlock ? "- Extra context Michael provided is FIRST-CLASS signal — weave into the relevant sections, reference by filename where applicable.\n" : ""}
---

## Output shape

Return ONLY valid JSON, no markdown code fences:
{
  "criticalToday": "3-5 urgent items cross-referenced across sources. Bullets, most urgent first. Null if nothing genuinely urgent.",
  "projectRadar": "Active projects needing attention across all sources. Bullets. Null if no active project signal.",
  "followUps": "Email replies needed, stalled actions, outstanding decision consequences. Bullets. Null if nothing.",
  "decisionsToWatch": "Recent decisions with pending follow-ups + any new decisions implied by today's data. Null if nothing.",
  "meetingsNeedingPrep": "Today's meetings with prep context. Null if no meetings with meaningful attendees.",
  "peopleAndAccounts": "Cross-source relationship signals. Null if no genuine cross-source signals.",
  "inboxSlack": "Remaining inbox/Slack highlights. Null if nothing further worth Michael's attention."
}`;

  // If we have binary file parts (PDFs, images), use the messages API so they
  // ride along on the user message. Otherwise use the simple prompt form.
  const messages: ModelMessage[] | undefined =
    extra.fileParts.length > 0
      ? [
          {
            role: "user",
            content: [
              { type: "text", text: promptText },
              ...extra.fileParts.map((p) => ({
                type: "file" as const,
                data: p.data,
                mediaType: p.mediaType,
                filename: p.filename,
              })),
            ],
          },
        ]
      : undefined;

  let result: Awaited<ReturnType<typeof generateText>>;
  try {
    result = await generateText({
      model: getTextModel("long"),
      maxOutputTokens: MAX_TOKENS.long,
      system: await getSystemPrompt(username, tz),
      ...(messages ? { messages } : { prompt: promptText }),
    });
  } catch (e) {
    console.error("[briefing] generateText failed:", e instanceof Error ? e.message : e);
    return Response.json(
      { error: "AI generation failed. Please try again in a moment." },
      { status: 503 }
    );
  }

  // Signal counts for trust UX — computed from the same data fed to the AI
  const dataSourceCounts: NonNullable<Briefing["dataSources"]> = {
    todayEvents:     calendarResult?.length ?? 0,
    emails:          emails.length,
    slackMessages:   slackMessages.length,
    zoomSummaries:   zoomResult.length,
    readSummaries:   readResult.length,
    openActions:     openActions.length,
    activeDecisions: activeDecisions.length,
    recentMemories:  recentMemories.length,
    projects:        projectTruthResult?.projects.length ?? 0,
    googleConnected,
    slackConnected,
  };

  // Computed source attribution (not AI-generated — built from real connection data)
  const sourceAttributionData: NonNullable<Briefing["sourceAttribution"]> = {
    connected:   connectedSources,
    unavailable: unavailableSources,
  };

  let briefingData: Briefing;
  const parseResult = parseAndValidate(result.text, BriefingOutputSchema, "[briefing]");
  if (parseResult.ok) {
    briefingData = {
      ...parseResult.data,
      generatedAt: new Date().toISOString(),
      extraContextSummary: extra.summary,
      dataSources: dataSourceCounts,
      sourceAttribution: sourceAttributionData,
    };
  } else {
    // Parse failure — return raw text in criticalToday so the UI shows something
    briefingData = {
      criticalToday: result.text,
      projectRadar: null,
      followUps: null,
      decisionsToWatch: null,
      meetingsNeedingPrep: null,
      peopleAndAccounts: null,
      inboxSlack: null,
      generatedAt: new Date().toISOString(),
      extraContextSummary: extra.summary,
      dataSources: dataSourceCounts,
      sourceAttribution: sourceAttributionData,
    };
  }

  // Persist to the generate-cache store (isolated from critical app state).
  // A cold-start cache miss is acceptable — regeneration is the fallback.
  try {
    const inputHash = computeInputHash(
      username,
      todayDate,
      String(actionsResult.length),
      String(decisionsResult.length),
      String(memoriesResult.length),
    );
    await writeGenerateCache(username, "briefing", briefingData, {
      inputHash,
      ttlMs: BRIEFING_TTL_MS,
    });
  } catch (e) {
    console.warn("[briefing] Failed to cache briefing:", e instanceof Error ? e.message : e);
  }

  return Response.json(briefingData);
}
