import { generateText, type ModelMessage } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { getSystemPrompt } from "@/lib/ai/system-prompt";
import { parseAIJson } from "@/lib/ai/parse-json";
import { getTodayEvents, type CalendarEvent } from "@/lib/google/calendar";
import { getRecentEmails, type GmailMessage } from "@/lib/google/gmail";
import {
  getRecentSlackMessages,
  type SlackMessage,
} from "@/lib/slack/client";
import {
  parseExtraContext,
  formatExtraContextBlock,
  type ExtraContext,
} from "@/lib/ai/extra-context";

// ── Format helpers ──

function formatCalendarBlock(events: CalendarEvent[]): string {
  if (events.length === 0) return "";
  return events
    .map((e) => {
      const time = e.isAllDay
        ? "All day"
        : `${new Date(e.start).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" })} – ${new Date(e.end).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" })}`;
      const video = e.hasVideo ? " [VIDEO]" : "";
      const attendees =
        e.attendeeCount > 0 ? ` (${e.attendeeCount} attendees)` : "";
      return `- ${time} | ${e.summary}${video}${attendees}`;
    })
    .join("\n");
}

function formatEmailBlock(emails: GmailMessage[]): string {
  if (emails.length === 0) return "";
  return emails
    .map((e) => {
      const unread = e.unread ? " [UNREAD]" : "";
      const snippet = e.snippet.length > 100 ? e.snippet.slice(0, 100) + "..." : e.snippet;
      return `- From: ${e.from} | Subject: ${e.subject}${unread}\n  Snippet: ${snippet}`;
    })
    .join("\n");
}

function formatSlackBlock(messages: SlackMessage[]): string {
  if (messages.length === 0) return "";
  return messages
    .map((m) => {
      const mention = m.isMention ? " [MENTIONS MICHAEL]" : "";
      const text = m.text.length > 150 ? m.text.slice(0, 150) + "..." : m.text;
      return `- ${m.channel} | ${m.author}${mention}: ${text}`;
    })
    .join("\n");
}

// ── Route ──

export async function POST(req: Request) {
  const today = new Date().toLocaleDateString("en-GB", {
    timeZone: "Europe/London",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  // Accept either multipart FormData (when the UI sends extra context) or
  // no body at all (backwards-compatible simple trigger).
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

  // Fetch all data sources in parallel, each wrapped in try/catch
  const [calendarResult, emailResult, slackResult] = await Promise.all([
    getTodayEvents().catch((err) => {
      console.error("Calendar fetch failed:", err);
      return null;
    }),
    getRecentEmails(12).catch((err) => {
      console.error("Email fetch failed:", err);
      return null;
    }),
    getRecentSlackMessages(15).catch((err) => {
      console.error("Slack fetch failed:", err);
      return null;
    }),
  ]);

  // Format each data source — null means the fetch failed, empty array means connected but no data
  const calendarBlock =
    calendarResult === null
      ? "Google Calendar not connected."
      : calendarResult.length === 0
        ? "No events on today's calendar."
        : formatCalendarBlock(calendarResult);

  const emailBlock =
    emailResult === null
      ? "Gmail not connected."
      : emailResult.length === 0
        ? "No recent emails in the last 48 hours."
        : formatEmailBlock(emailResult);

  const slackBlock =
    slackResult === null
      ? "Slack not connected."
      : slackResult.length === 0
        ? "No recent Slack messages."
        : formatSlackBlock(slackResult);

  const extraBlock = formatExtraContextBlock(extra);

  const promptText = `Generate Michael's daily briefing for ${today}. This is a sharp executive cheatsheet — depth, judgement, prioritisation, Basil's voice.

## LIVE DATA — Today's Calendar
${calendarBlock}

## LIVE DATA — Recent Emails (last 48h)
${emailBlock}

## LIVE DATA — Slack Highlights
${slackBlock}
${extraBlock ? `\n${extraBlock}` : ""}
## How Basil writes a briefing

Write this the way a great chief of staff would: direct, opinionated, prioritised, useful. Michael scans this before his day — he wants insight, not a log.

- Lead each section with what matters most, not what happened first. Rank by impact on Michael's day.
- Cross-reference sources aggressively *when both sides are in the live data* — if a meeting attendee above also appears as a recent email sender or in a Slack thread, call that out ("Crystal is in the 18:00 sync and sent colour palettes this morning — review before the call").
- Use your voice — noticing, flagging, connecting. "Worth reviewing before Thursday." "Ed will track this." "This thread's gone quiet — nudge?"
- Read tone from contact personas for interpretation ("Ed's @here means he wants action today, not this week"), but never quote or attribute to personas.
- Give real depth where the data supports it. Multiple paragraphs is fine. Bullets are fine. No artificial length cap.
${extraBlock ? "- When Michael has attached notes, files, or a folder, WEAVE them into the briefing — treat them as top-priority signal. Reference them by name. If they change your read of calendar/inbox/Slack, say so.\n" : ""}
## Factual guardrails — non-negotiable

Basil is rich but never invents. Rules for specific claims:

- Every name, company, meeting title, email subject, Slack quote, dollar figure, deadline, decision, and commitment must come from the LIVE DATA blocks above${extraBlock ? " (including EXTRA CONTEXT)" : ""} or from what you already know is true about Michael's team/products from the system prompt. If it is not in the live data, you do not state it as fact.
- Do NOT invent prospects, companies, deal stages, figures, percentages, ticket numbers, or product names that don't appear above.
- Do NOT fabricate quotes or attribute positions to people. If someone's view isn't in the data, don't claim they hold it.
- Persona notes in the system prompt are STYLE guidance only — never a source of "what X is doing this week".
- If a data source says "not connected", that section is exactly: "Not connected — connect to see briefing content."
- If a source is connected but genuinely empty, say so briefly in Basil's voice ("Inbox is quiet — nothing needing action.") and move on.

The bar: every specific fact traceable to live data, every interpretation clearly Basil's judgement grounded in those facts.

## Output shape

Respond with JSON. Each field is free-form text (paragraphs, bullet lines, numbered lists all fine — they render nicely). Length should match the density of real data.

{
  "calendar": "Today's calendar with Basil's read — what's the anchor meeting, what needs prep, where the gaps are. Cross-reference attendees against recent email/Slack above.",
  "emails": "Inbox highlights with priorities — who's waiting on you, what's urgent, what's noise. Reference specific senders and subjects from the live data.",
  "slack": "Slack digest with Basil's read — DMs to answer, threads to watch, mentions. Name specific people and channels from the live data.",
  "tasks": "Action list for today — concrete items grounded in the calendar/emails/Slack above. Bullets or numbered list. Put the most important first. Each item should be specific enough that Michael knows exactly what 'done' looks like.",
  "decisions": "Decisions Michael needs to make today or this week — each one traceable to something in the live data above. Empty sections return null (don't fill with hedge prose)."
}

Return ONLY valid JSON, no markdown code fences.`;

  // If we have binary file parts (PDFs, images), use the messages API so they
  // ride along on the user message. Otherwise stick with the simple prompt form.
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
    model: anthropic("claude-sonnet-4-6"),
    system: await getSystemPrompt(),
    ...(messages ? { messages } : { prompt: promptText }),
  });

  try {
    const parsed = parseAIJson<Record<string, unknown>>(result.text);
    return Response.json({
      ...parsed,
      generatedAt: new Date().toISOString(),
      extraContextSummary: extra.summary,
    });
  } catch {
    return Response.json({
      calendar: result.text,
      emails: "",
      slack: "",
      tasks: "",
      decisions: "",
      generatedAt: new Date().toISOString(),
      extraContextSummary: extra.summary,
    });
  }
}
