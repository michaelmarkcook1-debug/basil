import { generateText } from "ai";
import { getSystemPrompt } from "@/lib/ai/system-prompt";
import { parseAIJson } from "@/lib/ai/parse-json";
import { getSettings } from "@/lib/settings/store";
import { getEventsForMonth } from "@/lib/google/calendar";
import { getRecentEmails } from "@/lib/google/gmail";
import { getRecentSlackMessages } from "@/lib/slack/client";
import { getZoomSummariesFromGmail } from "@/lib/google/zoom-summaries";
import { getTeamsMeetings, type TeamsMeeting } from "@/lib/microsoft/teams";
import { listActions, isActionStalled } from "@/lib/actions/store";
import { listDecisions } from "@/lib/decisions/store";
import { listMemories } from "@/lib/memory/store";
import { getSessionUser } from "@/lib/auth";
import type { CalendarEvent } from "@/lib/google/calendar";
import type { GmailMessage } from "@/lib/google/gmail";
import type { SlackMessage } from "@/lib/slack/client";
import type { ZoomSummary } from "@/lib/google/zoom-summaries";
import type { Memory } from "@/lib/memory/types";

// ── Helpers ──

function formatDate(d: Date, tz = "Europe/London"): string {
  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: tz,
  });
}

function eventDateStr(event: CalendarEvent): string {
  return (event.start || "").substring(0, 10);
}

function formatCalendarBlock(events: CalendarEvent[], label: string, tz = "Europe/London"): string {
  if (events.length === 0) return `=== ${label} ===\n(No events found)\n`;

  const lines = events.map((e) => {
    const time = e.isAllDay
      ? "All day"
      : new Date(e.start).toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: tz,
        });
    const attendees =
      e.attendeeCount > 0 ? ` [${e.attendees.slice(0, 5).join(", ")}]` : "";
    const video = e.hasVideo ? " (video)" : "";
    return `- ${e.dateLabel || eventDateStr(e)} ${time}: ${e.summary}${video}${attendees}`;
  });

  return `=== ${label} (${events.length} events) ===\n${lines.join("\n")}\n`;
}

function formatEmailBlock(emails: GmailMessage[], label = "RECENT EMAILS", tz = "Europe/London"): string {
  if (emails.length === 0) return `=== ${label} ===\n(No emails found)\n`;

  const lines = emails.map((e) => {
    const date = new Date(e.date).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      timeZone: tz,
    });
    const unread = e.unread ? " [UNREAD]" : "";
    return `- ${date} from ${e.from}: ${e.subject}${unread}\n  ${e.snippet.substring(0, 180)}`;
  });

  return `=== ${label} (${emails.length}) ===\n${lines.join("\n")}\n`;
}

function formatZoomBlock(summaries: ZoomSummary[], tz = "Europe/London"): string {
  if (summaries.length === 0) return "=== ZOOM MEETING SUMMARIES ===\n(No Zoom summaries found)\n";
  const lines = summaries.map((s) => {
    const date = new Date(s.date).toLocaleDateString("en-GB", {
      day: "numeric", month: "short", timeZone: tz,
    });
    const body = s.body.length > 600 ? s.body.slice(0, 600) + "…" : s.body;
    return `- [${date}] ${s.title}\n  ${body}`;
  });
  return `=== ZOOM MEETING SUMMARIES (last 14 days, ${summaries.length} found) ===\n${lines.join("\n")}\n`;
}

function formatSlackBlock(messages: SlackMessage[], tz = "Europe/London"): string {
  if (messages.length === 0)
    return "=== RECENT SLACK MESSAGES ===\n(No messages found)\n";

  const lines = messages.map((m) => {
    const date = new Date(m.date).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      timeZone: tz,
    });
    const mention = m.isMention ? " [MENTIONS MICHAEL]" : "";
    return `- ${date} ${m.channel} — ${m.author}: ${m.text.substring(0, 220)}${mention}`;
  });

  return `=== RECENT SLACK MESSAGES (${messages.length}) ===\n${lines.join("\n")}\n`;
}

// ── Route handler ──

export async function POST() {
  const username = (await getSessionUser());
  if (!username) return Response.json({ error: "Unauthorised" }, { status: 401 });

  const settings    = await getSettings(username).catch(() => null);
  const tz          = settings?.timezone || "Europe/London";

  const now = new Date();
  // Align windows to the start of the current calendar week (Monday) in user's timezone,
  // so "this week" always means Mon–Sun, not a rolling 7-day window.
  const todayStr     = now.toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
  const nowLocal     = new Date(todayStr + "T00:00:00"); // midnight local (used for Mon calc)
  const dayOfWeek    = nowLocal.getDay(); // 0=Sun,1=Mon,...6=Sat
  const daysFromMon  = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // days since last Monday
  const weekStart    = new Date(now);
  weekStart.setDate(now.getDate() - daysFromMon);
  weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);

  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const sevenDaysAhead = new Date(now);
  sevenDaysAhead.setDate(sevenDaysAhead.getDate() + 7);
  const fourteenDaysAgo = new Date(now);
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  // Fetch all data sources in parallel — each wrapped in a try/catch so a
  // single source failing never aborts the whole digest.
  const [
    calendarEvents,
    emails,
    slackMessages,
    zoomSummaries,
    teamsMeetings,
    actionsResult,
    decisionsResult,
    memoriesResult,
  ] = await Promise.all([
    (async (): Promise<CalendarEvent[]> => {
      try {
        const currentYear = now.getFullYear();
        const currentMonth = now.getMonth();
        const currentMonthEvents = await getEventsForMonth(username, currentYear, currentMonth);

        let prevMonthEvents: CalendarEvent[] = [];
        if (sevenDaysAgo.getMonth() !== currentMonth) {
          prevMonthEvents = await getEventsForMonth(
            username,
            sevenDaysAgo.getFullYear(),
            sevenDaysAgo.getMonth()
          );
        }

        let nextMonthEvents: CalendarEvent[] = [];
        if (sevenDaysAhead.getMonth() !== currentMonth) {
          nextMonthEvents = await getEventsForMonth(
            username,
            sevenDaysAhead.getFullYear(),
            sevenDaysAhead.getMonth()
          );
        }

        return [...prevMonthEvents, ...currentMonthEvents, ...nextMonthEvents];
      } catch (e) {
        console.error("Failed to fetch calendar events:", e);
        return [];
      }
    })(),

    (async (): Promise<GmailMessage[]> => {
      try {
        return await getRecentEmails(username, 30);
      } catch (e) {
        console.error("Failed to fetch emails:", e);
        return [];
      }
    })(),

    (async (): Promise<SlackMessage[]> => {
      try {
        return await getRecentSlackMessages(username, 30);
      } catch (e) {
        console.error("Failed to fetch Slack messages:", e);
        return [];
      }
    })(),

    (async (): Promise<ZoomSummary[]> => {
      try {
        return await getZoomSummariesFromGmail(username, 14, 8);
      } catch (e) {
        console.error("Failed to fetch Zoom summaries:", e);
        return [];
      }
    })(),

    (async (): Promise<TeamsMeeting[]> => {
      try {
        return await getTeamsMeetings(username, 14);
      } catch (e) {
        console.error("Failed to fetch Teams meetings:", e);
        return [];
      }
    })(),

    listActions().catch((e) => {
      console.error("Failed to fetch actions:", e);
      return [];
    }),

    listDecisions().catch((e) => {
      console.error("Failed to fetch decisions:", e);
      return [];
    }),

    listMemories(username).catch((e) => {
      console.error("Failed to fetch memories:", e);
      return [] as Memory[];
    }),
  ]);

  // ── Calendar: split past vs upcoming ──────────────────────────────────────

  // todayStr already computed above; derive other date strings for calendar filtering
  const weekStartStr    = weekStart.toLocaleDateString("en-CA", { timeZone: tz });
  const sevenDaysAgoStr = sevenDaysAgo.toLocaleDateString("en-CA", { timeZone: tz });
  const sevenDaysAheadStr = sevenDaysAhead.toLocaleDateString("en-CA", { timeZone: tz });

  const pastEvents = calendarEvents.filter((e) => {
    const d = eventDateStr(e);
    return d >= sevenDaysAgoStr && d < todayStr;
  });

  const upcomingEvents = calendarEvents.filter((e) => {
    const d = eventDateStr(e);
    return d >= todayStr && d <= sevenDaysAheadStr;
  });

  // ── Actions: 5 buckets — all scoped to the current Mon–Sun calendar week ──
  // Bucket 1: completed this week (since Monday)
  const completedThisWeek = actionsResult.filter((a) => {
    if (a.status !== "done") return false;
    const updated = a.updatedAt ?? a.createdAt;
    if (!updated) return false;
    return new Date(updated).getTime() >= weekStart.getTime();
  });

  // Bucket 2: opened/created this week (since Monday, not yet done)
  const openedThisWeek = actionsResult.filter((a) => {
    if (a.status === "done") return false;
    if (!a.createdAt) return false;
    return new Date(a.createdAt).getTime() >= weekStart.getTime();
  });

  const todayIso = todayStr; // already YYYY-MM-DD in user's timezone
  const PORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

  // Bucket 3: overdue (open with past due date)
  const overdueActions = actionsResult
    .filter((a) => {
      if (a.status === "done") return false;
      return a.status === "overdue" || (a.status === "open" && !!a.dueDate && a.dueDate < todayIso);
    })
    .sort((a, b) => (PORDER[a.priority ?? "low"] ?? 2) - (PORDER[b.priority ?? "low"] ?? 2));

  // Bucket 4: stalled (open, no due date, no recent activity)
  const stalledActions = actionsResult.filter((a) => {
    if (a.status === "done") return false;
    return isActionStalled(a);
  });

  // Bucket 5: due next 7 days (open, not overdue, not stalled)
  const overdueOrStalledIds = new Set([
    ...overdueActions.map((a) => a.id),
    ...stalledActions.map((a) => a.id),
  ]);
  const dueNextWeek = actionsResult
    .filter((a) => {
      if (a.status === "done") return false;
      if (overdueOrStalledIds.has(a.id)) return false;
      if (!a.dueDate) return false;
      return a.dueDate >= todayIso && a.dueDate <= sevenDaysAheadStr;
    })
    .sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : 1));

  const allOpenActions = actionsResult.filter((a) => a.status !== "done");

  // Format action blocks
  function formatActionList(
    actions: typeof actionsResult,
    label: string,
    cap = 15
  ): string {
    if (actions.length === 0) return `=== ${label} ===\n(none)\n`;
    return (
      `=== ${label} (${actions.length}) ===\n` +
      actions
        .slice(0, cap)
        .map((a) => {
          const flags: string[] = [];
          if (a.dueDate) flags.push(`due ${a.dueDate}`);
          if (a.priority === "high") flags.push("HIGH");
          if (a.owner && a.owner !== "Michael Cook") flags.push(`owner: ${a.owner}`);
          if (a.source && a.source !== "manual") flags.push(a.source);
          return `- ${a.text}${flags.length ? ` (${flags.join(", ")})` : ""}`;
        })
        .join("\n") +
      "\n"
    );
  }

  const actionsBlock = [
    formatActionList(completedThisWeek, "COMPLETED THIS WEEK"),
    formatActionList(openedThisWeek, "OPENED THIS WEEK (not yet done)"),
    formatActionList(overdueActions, "OVERDUE"),
    formatActionList(stalledActions, "STALLED (open, no due date, no activity ≥14 days)"),
    formatActionList(dueNextWeek, "DUE NEXT 7 DAYS"),
  ].join("\n");

  // ── Decisions: last 14 days ────────────────────────────────────────────────
  const recentDecisions = decisionsResult
    .filter((d) => {
      if (d.status === "superseded") return false;
      if (!d.date) return true;
      return new Date(d.date).getTime() >= fourteenDaysAgo.getTime();
    })
    .sort(
      (a, b) =>
        new Date(b.updatedAt ?? b.date ?? "").getTime() -
        new Date(a.updatedAt ?? a.date ?? "").getTime()
    )
    .slice(0, 15);

  const decisionsBlock =
    recentDecisions.length === 0
      ? "=== RECENT DECISIONS (last 14 days) ===\n(No decisions logged in this window)\n"
      : `=== RECENT DECISIONS — last 14 days (${recentDecisions.length}) ===\n` +
        recentDecisions
          .map((d) => {
            const headline = d.title ? `${d.title}: ${d.text}` : d.text;
            const meta: string[] = [];
            if (d.decidedBy) meta.push(d.decidedBy);
            if (d.date) meta.push(d.date);
            if (d.source) meta.push(`via ${d.source}`);
            const metaStr = meta.length > 0 ? ` (${meta.join(", ")})` : "";
            const rationaleStr = d.rationale ? `\n  Rationale: ${d.rationale}` : "";
            const consequencesStr =
              d.consequences && d.consequences.length > 0
                ? `\n  Follow-ons: ${d.consequences.join("; ")}`
                : "";
            return `- ${headline}${metaStr}${rationaleStr}${consequencesStr}`;
          })
          .join("\n") + "\n";

  // ── Memory: last 30 days ───────────────────────────────────────────────────
  const recentMemories = (memoriesResult as Memory[])
    .filter((m) => new Date(m.updatedAt).getTime() > thirtyDaysAgo.getTime())
    .slice(0, 20);

  const memoryBlock =
    recentMemories.length > 0
      ? `=== BASIL'S MEMORY NOTES (last 30 days, ${recentMemories.length}) ===\n` +
        recentMemories
          .map((m) => `- [${m.kind}${m.entity ? ` · ${m.entity}` : ""}] ${m.content}`)
          .join("\n") + "\n"
      : "=== BASIL'S MEMORY NOTES ===\n(No recent notes)\n";

  // ── Signal density ─────────────────────────────────────────────────────────
  const totalSignal =
    pastEvents.length +
    upcomingEvents.length +
    emails.length +
    slackMessages.length +
    zoomSummaries.length +
    teamsMeetings.length +
    completedThisWeek.length +
    allOpenActions.length +
    recentDecisions.length;

  // ── Prompt ────────────────────────────────────────────────────────────────

  const liveDataBlock = [
    "╔══════════════════════════════════════╗",
    "║         LIVE DATA — DO NOT IGNORE    ║",
    "╚══════════════════════════════════════╝",
    "",
    `Generated: ${now.toISOString()}`,
    `Window: ${formatDate(sevenDaysAgo, tz)} → ${formatDate(now, tz)} (recap) | ${formatDate(now, tz)} → ${formatDate(sevenDaysAhead, tz)} (forward)`,
    `Signal density: ${totalSignal} live items + ${recentMemories.length} memory note(s).`,
    "",
    formatCalendarBlock(pastEvents, "PAST 7 DAYS — CALENDAR"),
    formatCalendarBlock(upcomingEvents, "NEXT 7 DAYS — CALENDAR"),
    formatEmailBlock(emails, "RECENT EMAILS (last 7 days)"),
    formatSlackBlock(slackMessages),
    zoomSummaries.length > 0 ? formatZoomBlock(zoomSummaries) : "",
    teamsMeetings.length > 0
      ? `=== MICROSOFT TEAMS MEETINGS (last 14 days, ${teamsMeetings.length} found) ===\n` +
        teamsMeetings.map((m) => `- [${m.date}] ${m.title}\n  ${m.body}`).join("\n") + "\n"
      : "",
    actionsBlock,
    decisionsBlock,
    memoryBlock,
    "",
    "╔══════════════════════════════════════╗",
    "║         END LIVE DATA                ║",
    "╚══════════════════════════════════════╝",
  ]
    .filter((line) => line !== "")
    .join("\n");

  const prompt = `Generate Michael Cook's weekly executive summary — a clear, honest account of the past 7 days and what next week needs.

${liveDataBlock}

IMPORTANT: Michael Cook is the CEO of AnalystGenius and VP of Product at TalentGenius. There is another person named Michael Trujillo who is a different team member — do NOT confuse them.

## How Basil writes a weekly summary

This is a chief-of-staff end-of-week note, not a data dump. Michael reads this on Friday afternoon or Sunday morning to understand: what actually happened, what shifted, what got decided, and where he needs to focus next week.

- Lead each section with the most important item, not chronology.
- Use Basil's voice: name the pattern, name the tension, flag what's ripening. "Crystal's timeline moved twice this week — unusual." "Ed's 1:1 slipped again — worth a word." "Three separate threads with Sona this week suggests something is converging."
- Cross-reference sources: if a calendar attendee also appeared in Slack, email, or a Zoom recap, connect the threads.
- Zoom meeting summaries are first-class evidence for meetings, decisions, and action items. Use them.
- Memory notes from Basil add context that raw source data lacks — use them to explain patterns or flag recurring themes.
- Length should match signal density. When the week was quiet, write a brief honest summary. Don't pad.
- Real depth is welcome when warranted: paragraphs, bullets, numbered lists all render.

## Factual guardrails — non-negotiable

- Every name, meeting title, email subject, Slack quote, figure, deadline, decision, and commitment must come from the LIVE DATA above.
- Do NOT invent meetings, deal stages, prospect names, company names, dollar figures, percentages, or outcomes.
- Do NOT infer a "decision" unless the live data contains explicit decision language.
- Do NOT infer "slipped" from absence — only flag if the live data contains explicit delay/missed/cancelled/rescheduled language.
- **Empty is an acceptable answer.** If a section has no supporting evidence, return null (not filler prose).
- If all live-data sources are empty or not connected, return null for ALL fields.

## Output shape

JSON. Each field is free-form text (paragraphs, bullets, numbered lists) or null.

{
  "majorMeetings": "Key meetings, 1:1s, and calls from the past 7 days. Who was there, what came out of it, what the signal means. Draw from PAST 7 DAYS CALENDAR and Zoom summaries. Cross-reference Slack/email threads involving the same people. Null if no meetings in the data.",
  "whatChanged": "What moved this week. Actions completed. Momentum made or lost. Work shipped or advanced. Draw from COMPLETED THIS WEEK and OPENED THIS WEEK actions, calendar, and Zoom recaps. Name specific items. Null if nothing evident.",
  "decisionsLog": "Decisions logged or clearly implied in the past 7-14 days. Each decision traceable to a line in the live data. Include rationale and follow-on consequences where present. Draw from RECENT DECISIONS block and Zoom summaries. Null if none.",
  "blockers": "What's stuck. Overdue actions. Stalled threads. Risks raised but unresolved. Items that need a nudge or decision to unblock. Draw from OVERDUE, STALLED, and blocker-language in emails/Slack/memory. Be specific — name the item, the owner, and why it matters. Null if nothing is genuinely blocked.",
  "relationshipSignals": "Cross-source signals about people and accounts. Who appeared in multiple channels this week? Any relationship that's warming, cooling, or needs attention? Any account activity worth noting? Draw from calendar attendees, email senders, Slack participants, and memory notes. Null if no cross-source signal.",
  "nextWeekNeeds": "What next week requires. Meetings that need prep. Open threads to close. Decisions that are ripening. Items from DUE NEXT 7 DAYS and NEXT 7 DAYS CALENDAR. Basil's one or two priorities for Michael's attention. Null if nothing notable upcoming."
}

Return ONLY valid JSON, no markdown code fences.`;

  const result = await generateText({
    model: "anthropic/claude-sonnet-4.6",
    system: await getSystemPrompt(username),
    prompt,
    providerOptions: {
      gateway: { tags: ["feature:digest", "env:production"] },
    },
  });

  try {
    const parsed = parseAIJson<Record<string, unknown>>(result.text);
    return Response.json({
      ...parsed,
      generatedAt: now.toISOString(),
      weekStart: weekStart.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: tz }),
      weekEnd:   weekEnd.toLocaleDateString("en-GB",   { day: "numeric", month: "short", timeZone: tz }),
      dataSources: {
        calendarPast: pastEvents.length,
        calendarUpcoming: upcomingEvents.length,
        emails: emails.length,
        slackMessages: slackMessages.length,
        zoomSummaries: zoomSummaries.length,
        teamsMeetings: teamsMeetings.length,
        completedActions: completedThisWeek.length,
        openActions: allOpenActions.length,
        recentDecisions: recentDecisions.length,
        memories: recentMemories.length,
      },
    });
  } catch {
    // Fallback: wrap any parseable text in the primary section
    return Response.json({
      majorMeetings: result.text || "Failed to parse digest response.",
      whatChanged: null,
      decisionsLog: null,
      blockers: null,
      relationshipSignals: null,
      nextWeekNeeds: null,
      generatedAt: now.toISOString(),
    });
  }
}
