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
import { getSystemPrompt } from "@/lib/ai/system-prompt";
import { parseAIJson } from "@/lib/ai/parse-json";
import { getSettings } from "@/lib/settings/store";
import { getTodayEvents, type CalendarEvent } from "@/lib/google/calendar";
import { getRecentEmails, type GmailMessage } from "@/lib/google/gmail";
import {
  getRecentSlackMessages,
  type SlackMessage,
} from "@/lib/slack/client";
import { getSessionUser } from "@/lib/auth";
import { listActions, isActionStalled } from "@/lib/actions/store";
import { listDecisions } from "@/lib/decisions/store";
import { getZoomSummariesFromGmail } from "@/lib/google/zoom-summaries";
import type { ZoomSummary } from "@/lib/google/zoom-summaries";
import { listMemories } from "@/lib/memory/store";
import type { Memory } from "@/lib/memory/types";
import {
  parseExtraContext,
  formatExtraContextBlock,
  type ExtraContext,
} from "@/lib/ai/extra-context";

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
      const mention = m.isMention ? " [@MICHAEL]" : "";
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

// ── Route ──────────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const username = (await getSessionUser());
  if (!username) return Response.json({ error: "Unauthorised" }, { status: 401 });

  const settings  = await getSettings(username).catch(() => null);
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
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    try {
      const form = await req.formData();
      extra = await parseExtraContext(form);
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
    memoriesResult,
  ] = await Promise.all([
    getTodayEvents(username).catch((err) => {
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
    listActions().catch((err) => {
      console.error("Actions fetch failed:", err);
      return [];
    }),
    listDecisions().catch((err) => {
      console.error("Decisions fetch failed:", err);
      return [];
    }),
    // 8 summaries from the last 7 days — richer Zoom context for today's attendees
    getZoomSummariesFromGmail(username, 7, 8).catch((err) => {
      console.error("Zoom summaries fetch failed:", err);
      return [];
    }),
    listMemories(username).catch((err) => {
      console.error("Memories fetch failed:", err);
      return [] as Memory[];
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
    if (a.owner && a.owner !== "Michael Cook") flags.push(`owner: ${a.owner}`);
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

  const extraBlock = formatExtraContextBlock(extra);

  // ── Signal density (for LOW SIGNAL discipline) ─────────────────────────
  const totalSignal =
    (calendarResult?.length ?? 0) +
    emails.length +
    slackMessages.length +
    zoomResult.length;

  // ── Build prompt ──────────────────────────────────────────────────────────
  const promptText = `Generate Michael's daily briefing for ${today}.
Goal: 3-minute executive read. Not a log — intelligence. Tell Michael what to do today, who to respond to, what to watch, and what to prepare for.

---

## SOURCE DATA

### TODAY'S CALENDAR
${calendarBlock}

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
` : ""}${memoryBlock ? `
### RELATIONSHIP MEMORY — person/context notes accumulated over prior interactions
${memoryBlock}
` : ""}${extraBlock ? `\n${extraBlock}\n` : ""}---

## Briefing structure

Write the way a great chief of staff would: opinionated, specific, cross-referenced. Michael scans this before his day begins.

**criticalToday** — 3-5 items that genuinely need attention today. Cross-source: if an overdue action also appears in an email thread, that is ONE item not two. If an attendee also sent a DM, that is ONE item. Rank by real urgency — not by which source listed it first. If there is nothing critical today, say so honestly ("Routine day — nothing critical.").

**followUps** — things requiring Michael's active response: email replies he hasn't sent, stalled actions that need a nudge, decision consequences that haven't been confirmed yet. For each: one line on what it is, one line on why it matters now. Name the person specifically.

**decisionsToWatch** — recent decisions from the Decision Log that have pending follow-up consequences listed. Flag if a consequence appears not yet actioned (don't claim it hasn't been — just flag it as worth checking). Also surface any genuinely new decisions implied by today's calendar or inbox (not fabricated — only if clearly implied by live data). Do NOT re-list already-made decisions as open items.

**meetingsNeedingPrep** — today's video/multi-attendee calendar meetings worth preparing for. For each: name + time, what the current context is (from email/Slack/Zoom summaries mentioning those attendees), what Michael should aim to land. If signal is thin, flag it ("No recent signal on this one — go in open"). Skip solo blocks and trivial quick syncs unless context makes them significant.

**peopleAndAccounts** — people or accounts appearing across multiple sources today (e.g. "Ed in 3pm meeting + unread email + Slack DM — three touchpoints suggesting something's live"), or where relationship memory or a recent Zoom note suggests a check-in is overdue. Specific and grounded. Null if no genuine cross-source signals.

**inboxSlack** — remaining inbox and Slack highlights not already covered above. Only what merits Michael's attention. Skip newsletters, Zoom join/confirmation emails, OOO replies, auto-notifications, and anything already surfaced in criticalToday or followUps.

---

## Factual guardrails — non-negotiable

Every name, company, email subject, Slack quote, action text, decision, and commitment must come from the SOURCE DATA above.
- Do NOT fabricate names, deal stages, company names, dollar figures, or product outcomes not present in the data.
- If a source is disconnected, say "Not connected" and move on.
- If connected but empty, say so briefly ("Inbox quiet", "No Slack signal") in the relevant section.
- Zoom summaries contain what was ACTUALLY SAID on prior calls — cross-reference their attendees with today's calendar for meetingsNeedingPrep.
- DECISION LOG entries are already-made decisions. Only surface them as "this decision has pending follow-ups" — never as "this still needs to be decided".
- Relationship memory notes are accumulated facts about people — use them to enrich peopleAndAccounts and meetingsNeedingPrep. Never invent claims beyond what the memory says.
- Signal density today: ${totalSignal} live source item(s)${recentMemories.length > 0 ? ` + ${recentMemories.length} memory note(s)` : ""}. If signal is low, produce a shorter briefing — an honest 2-item brief beats a padded fabrication.
- Items marked [UNCONFIRMED] or "UNCONFIRMED — awaiting review" are candidates Basil identified from signals but Michael has not yet verified. Present these as tentative ("may have been decided", "worth checking", "appears to") — never as confirmed facts or firm commitments.
${extraBlock ? "- Extra context Michael provided is FIRST-CLASS signal — weave into the relevant sections, reference by filename where applicable.\n" : ""}
---

## Output shape

Return ONLY valid JSON, no markdown code fences:
{
  "criticalToday": "3-5 urgent items cross-referenced across sources. Bullets, most urgent first. Null if nothing genuinely urgent.",
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

  const result = await generateText({
    model: "anthropic/claude-sonnet-4.6",
    system: await getSystemPrompt(username),
    ...(messages ? { messages } : { prompt: promptText }),
    providerOptions: {
      gateway: { tags: ["feature:briefing", "env:production"] },
    },
  });

  try {
    const parsed = parseAIJson<Record<string, unknown>>(result.text);
    return Response.json({
      ...parsed,
      generatedAt: new Date().toISOString(),
      extraContextSummary: extra.summary,
    });
  } catch {
    // Parse failure — return raw text in criticalToday so the UI shows something
    return Response.json({
      criticalToday: result.text,
      followUps: null,
      decisionsToWatch: null,
      meetingsNeedingPrep: null,
      peopleAndAccounts: null,
      inboxSlack: null,
      generatedAt: new Date().toISOString(),
      extraContextSummary: extra.summary,
    });
  }
}
