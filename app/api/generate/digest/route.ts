import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { getSystemPrompt } from "@/lib/ai/system-prompt";
import { parseAIJson } from "@/lib/ai/parse-json";
import { getEventsForMonth } from "@/lib/google/calendar";
import { getRecentEmails } from "@/lib/google/gmail";
import { getRecentSlackMessages } from "@/lib/slack/client";
import type { CalendarEvent } from "@/lib/google/calendar";
import type { GmailMessage } from "@/lib/google/gmail";
import type { SlackMessage } from "@/lib/slack/client";

// ── Helpers ──

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "Europe/London",
  });
}

function eventDateStr(event: CalendarEvent): string {
  return (event.start || "").substring(0, 10);
}

function formatCalendarBlock(events: CalendarEvent[], label: string): string {
  if (events.length === 0) return `=== ${label} ===\n(No events found)\n`;

  const lines = events.map((e) => {
    const time = e.isAllDay
      ? "All day"
      : new Date(e.start).toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "Europe/London",
        });
    const attendees =
      e.attendeeCount > 0 ? ` [${e.attendees.slice(0, 5).join(", ")}]` : "";
    const video = e.hasVideo ? " (video)" : "";
    return `- ${e.dateLabel || eventDateStr(e)} ${time}: ${e.summary}${video}${attendees}`;
  });

  return `=== ${label} (${events.length} events) ===\n${lines.join("\n")}\n`;
}

function formatEmailBlock(emails: GmailMessage[]): string {
  if (emails.length === 0) return "=== RECENT EMAILS ===\n(No emails found)\n";

  const lines = emails.map((e) => {
    const date = new Date(e.date).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      timeZone: "Europe/London",
    });
    const unread = e.unread ? " [UNREAD]" : "";
    return `- ${date} from ${e.from}: ${e.subject}${unread}\n  ${e.snippet.substring(0, 150)}`;
  });

  return `=== RECENT EMAILS (${emails.length}) ===\n${lines.join("\n")}\n`;
}

function formatSlackBlock(messages: SlackMessage[]): string {
  if (messages.length === 0)
    return "=== RECENT SLACK MESSAGES ===\n(No messages found)\n";

  const lines = messages.map((m) => {
    const date = new Date(m.date).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      timeZone: "Europe/London",
    });
    const mention = m.isMention ? " [MENTIONS MICHAEL]" : "";
    return `- ${date} ${m.channel} — ${m.author}: ${m.text.substring(0, 200)}${mention}`;
  });

  return `=== RECENT SLACK MESSAGES (${messages.length}) ===\n${lines.join("\n")}\n`;
}

// ── Route handler ──

export async function POST() {
  const now = new Date();
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const sevenDaysAhead = new Date(now);
  sevenDaysAhead.setDate(sevenDaysAhead.getDate() + 7);

  // Fetch all data sources in parallel, each wrapped in try/catch
  const [calendarEvents, emails, slackMessages] = await Promise.all([
    (async (): Promise<CalendarEvent[]> => {
      try {
        // Get current month and, if needed, the adjacent month to cover the full 14-day window
        const currentYear = now.getFullYear();
        const currentMonth = now.getMonth(); // 0-indexed

        const currentMonthEvents = await getEventsForMonth(
          currentYear,
          currentMonth
        );

        // If the 7-day-ago window falls in the previous month, fetch that too
        let prevMonthEvents: CalendarEvent[] = [];
        if (sevenDaysAgo.getMonth() !== currentMonth) {
          const prevMonth = sevenDaysAgo.getMonth();
          const prevYear = sevenDaysAgo.getFullYear();
          prevMonthEvents = await getEventsForMonth(prevYear, prevMonth);
        }

        // If the 7-day-ahead window falls in the next month, fetch that too
        let nextMonthEvents: CalendarEvent[] = [];
        if (sevenDaysAhead.getMonth() !== currentMonth) {
          const nextMonth = sevenDaysAhead.getMonth();
          const nextYear = sevenDaysAhead.getFullYear();
          nextMonthEvents = await getEventsForMonth(nextYear, nextMonth);
        }

        return [...prevMonthEvents, ...currentMonthEvents, ...nextMonthEvents];
      } catch (e) {
        console.error("Failed to fetch calendar events:", e);
        return [];
      }
    })(),

    (async (): Promise<GmailMessage[]> => {
      try {
        return await getRecentEmails(20);
      } catch (e) {
        console.error("Failed to fetch emails:", e);
        return [];
      }
    })(),

    (async (): Promise<SlackMessage[]> => {
      try {
        return await getRecentSlackMessages(20);
      } catch (e) {
        console.error("Failed to fetch Slack messages:", e);
        return [];
      }
    })(),
  ]);

  // Split calendar events into past 7 days and next 7 days
  const todayStr = now.toLocaleDateString("en-CA", {
    timeZone: "Europe/London",
  });
  const sevenDaysAgoStr = sevenDaysAgo.toLocaleDateString("en-CA", {
    timeZone: "Europe/London",
  });
  const sevenDaysAheadStr = sevenDaysAhead.toLocaleDateString("en-CA", {
    timeZone: "Europe/London",
  });

  const pastEvents = calendarEvents.filter((e) => {
    const d = eventDateStr(e);
    return d >= sevenDaysAgoStr && d < todayStr;
  });

  const upcomingEvents = calendarEvents.filter((e) => {
    const d = eventDateStr(e);
    return d >= todayStr && d <= sevenDaysAheadStr;
  });

  // Build the live data blocks
  const liveDataBlock = [
    "╔══════════════════════════════════════╗",
    "║         LIVE DATA — DO NOT IGNORE    ║",
    "╚══════════════════════════════════════╝",
    "",
    `Generated: ${now.toISOString()}`,
    `Window: ${formatDate(sevenDaysAgo)} → ${formatDate(now)} (recap) | ${formatDate(now)} → ${formatDate(sevenDaysAhead)} (forward)`,
    "",
    formatCalendarBlock(pastEvents, "PAST 7 DAYS — CALENDAR"),
    formatCalendarBlock(upcomingEvents, "NEXT 7 DAYS — CALENDAR"),
    formatEmailBlock(emails),
    formatSlackBlock(slackMessages),
    "",
    "╔══════════════════════════════════════╗",
    "║         END LIVE DATA                ║",
    "╚══════════════════════════════════════╝",
  ].join("\n");

  const prompt = `Generate Michael Cook's weekly digest — a sharp, opinionated retrospective + forward look, split into AnalystGenius (AG) and AgentPowered/TalentGenius (AP/TG) columns.

${liveDataBlock}

IMPORTANT: Michael Cook is the CEO of AnalystGenius and VP of Product at TalentGenius. There is ANOTHER person named Michael Trujillo who is a different team member — do NOT confuse them.

## How Basil writes a digest

Write this the way a great chief of staff writes a Sunday-night prep note: scannable, opinionated, cross-referenced. Michael reads this to prime for the week ahead, not to tick a box.

- Lead each column with what matters most for that product — rank by impact, not chronology.
- Use Basil's voice: name the pattern, name the tension, flag what's ripening. "Crystal moved twice this week — unusual, check it's not a signal." "Ed's 1:1 slipped again — third time, worth a word."
- Cross-reference sources when both sides are in the live data — if a calendar attendee also sent email or appeared in Slack, connect them.
- Use persona notes in the system prompt for TONE ("Ed likes execution detail", "Malcolm wants strategy") — never for claims about what someone did.
- Real depth is welcome. Paragraphs, bullets, numbered lists all render. No artificial length cap. Length should match the signal density.

## Factual guardrails — non-negotiable

Basil is rich but never invents. Michael makes real decisions off this.

- Every name, meeting title, email subject, Slack quote, figure, deadline, decision, and commitment must come from the LIVE DATA above. If it's not there, you do not state it as fact.
- Do NOT invent meetings, deal stages, prospect names, company names, dollar figures, percentages, or outcomes.
- Do NOT infer a "decision" unless the live data contains explicit decision language (confirming, approving, announcing a choice).
- Do NOT infer "slipped" from absence — only flag something as slipped if the live data contains explicit delay/missed/cancelled/rescheduled language.
- Classify each data point as AG or AP/TG only when the people or topics make it unambiguous. If ambiguous, omit it rather than guess.
- Persona notes are STYLE guidance only — never a source of "what X did this week".
- **Empty is an acceptable answer.** If a section has no supporting evidence, return null for that field (not filler prose). A mostly-null digest is better than a fabricated one.
- If all live-data sources are empty or not connected, return null for ALL fields.

## Output shape

JSON. Each field is free-form text (paragraphs, bullets, or numbered lists render cleanly) or null.

{
  "ag": {
    "shipped": "What landed for AG this week — grounded in specific calendar events/Slack/emails from the past 7 days. Basil's read on the signal behind the fact. Null if nothing in the data supports it.",
    "slipped": "AG items explicitly delayed, cancelled, rescheduled, or flagged as overdue in the live data. Basil's take on why it matters. Null if no explicit slippage.",
    "whoYouMet": "AG meetings/1:1s from PAST 7 DAYS CALENDAR. Name the person, note what's worth remembering from context (Slack/email threads involving them). Null if no AG meetings.",
    "decisions": "AG decisions explicitly recorded in the live data. Each traceable to a line above. Null if none.",
    "carryForward": "AG items in NEXT 7 DAYS CALENDAR or unresolved threads — what needs prep, what's at risk, what Basil is watching. Null if nothing upcoming."
  },
  "aptg": {
    "shipped": "Same treatment, AP/TG-scoped. Null if none.",
    "slipped": "Same rules. Null if none.",
    "whoYouMet": "Same rules. Null if none.",
    "decisions": "Same rules. Null if none.",
    "carryForward": "Same rules. Null if none."
  }
}

Return ONLY valid JSON, no markdown code fences.`;

  const result = await generateText({
    model: anthropic("claude-sonnet-4-6"),
    system: await getSystemPrompt(),
    prompt,
  });

  try {
    const parsed = parseAIJson<Record<string, unknown>>(result.text);
    return Response.json({
      ...parsed,
      generatedAt: now.toISOString(),
      dataSources: {
        calendarPast: pastEvents.length,
        calendarUpcoming: upcomingEvents.length,
        emails: emails.length,
        slackMessages: slackMessages.length,
      },
    });
  } catch {
    return Response.json({
      error: "Failed to parse digest",
      raw: result.text,
      generatedAt: now.toISOString(),
    });
  }
}
