import { tool } from "ai";
import { z } from "zod";
import { webSearch, fetchPageContent } from "@/lib/web/search";
import { isGoogleConnected } from "@/lib/google/auth";
import { getTodayEvents, createCalendarEvent, getEventsForDate, getEventsForDateRange, checkFreeBusy } from "@/lib/google/calendar";
import { getRecentEmails, searchEmails, createDraft, getEmailBody } from "@/lib/google/gmail";
import { searchDriveFiles } from "@/lib/google/drive";
import { isSlackConnected, getRecentSlackMessages, searchSlackMessages, sendSlackMessage as slackSend, getUserProfile } from "@/lib/slack/client";
import {
  createMemory,
  deleteMemory,
  getMemoriesForEntity,
  listMemories,
} from "@/lib/memory/store";
import {
  listActions,
  createAction,
  updateAction,
  deleteAction,
} from "@/lib/actions/store";
import {
  listDecisions,
  createDecision,
  updateDecision,
} from "@/lib/decisions/store";
import { emitAuditEvent } from "@/lib/events/audit";
import { syncLinearActionStates } from "@/lib/linear/sync-actions";
import {
  isLinearConnected,
  getAllIssues,
  getWorkflowStates,
  updateIssue as updateLinearIssue,
} from "@/lib/linear/client";
import { findContactByName, timezoneFromLocation } from "@/lib/contacts-lookup";
import { listUserContacts } from "@/lib/contacts/user-store";
// NOTE: domain sync (emitChange) is NOT called here — tools.ts runs server-side
// inside the /api/chat route handler where `window` is undefined.  Domain changes
// are broadcast client-side by the post-stream handler in app/dashboard/chat/page.tsx
// which scans completed assistant message parts.  In AI SDK v6 each tool call
// surfaces as a part with type "tool-<toolName>" (e.g. "tool-addAction") and
// state "output-available" when the tool has run successfully.

/**
 * Build the full assistant tool set scoped to the given user.
 *
 * All Google, Slack, memory, and tracker operations are per-user.
 * Tool descriptions use the user's first name so the model has correct context
 * about whose data it is reading/writing.
 *
 * @param username  The authenticated user's login name (e.g. "michael").
 * @param firstName Optional display first name override. Derived from username if omitted.
 */
export function buildAssistantTools(username: string, firstName?: string, timezone = "Europe/London") {
  // Derive a readable first name from the username if not explicitly provided.
  // "michael" → "Michael", "alice_jones" → "Alice"
  const name = firstName
    ?? username
        .replace(/[_.-]/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .split(" ")[0];

  return {
    // ── READ-ONLY TOOLS ──

    getCalendarEvents: tool({
      description:
        `Get calendar events for a specific date or date range. Use this whenever ${name} asks about their schedule, availability, meetings, or wants to book time on a specific day. Always pass the target date — do NOT default to today if ${name} mentions tomorrow, next Monday, etc.`,
      inputSchema: z.object({
        date: z
          .string()
          .optional()
          .describe("Target date in YYYY-MM-DD format. Omit only for today's events."),
        endDate: z
          .string()
          .optional()
          .describe(
            "Optional end date (YYYY-MM-DD) to fetch a range. E.g. pass startDate=Monday and endDate=Friday to see the full week."
          ),
      }),
      execute: async ({ date, endDate }) => {
        if (!(await isGoogleConnected(username))) {
          return { error: `Google Calendar not connected. ${name} needs to connect Google in Settings.` };
        }
        try {
          if (date && endDate) {
            const events = await getEventsForDateRange(username, date, endDate, timezone);
            return { events, count: events.length, dateRange: `${date} → ${endDate}` };
          }
          if (date) {
            const events = await getEventsForDate(username, date, timezone);
            return { events, count: events.length, date };
          }
          const events = await getTodayEvents(username, timezone);
          return { events, count: events.length, date: "today" };
        } catch (e) {
          return { error: `Calendar fetch failed: ${e instanceof Error ? e.message : String(e)}` };
        }
      },
    }),

    searchEmails: tool({
      description:
        `Search Gmail. Pass Gmail search operators in \`query\` (e.g. \`from:someone@example.com\`, \`subject:launch\`, \`has:attachment\`). Omit \`query\` to get the most recent 2 days of mail. Results include an \`id\` field and a short \`snippet\` (~200 chars) — if ${name} needs the full contents of a message, follow up with \`readEmail\` using that id.`,
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe(
            "Gmail search query. Supports operators: from:, to:, subject:, has:attachment, etc. Leave empty for recent mail."
          ),
        limit: z.number().optional().describe("Max results. Defaults to 5."),
      }),
      execute: async ({ query, limit }) => {
        if (!(await isGoogleConnected(username))) {
          return { error: `Gmail not connected. ${name} needs to connect Google in Settings.` };
        }
        const emails = query
          ? await searchEmails(username, query, limit || 5)
          : await getRecentEmails(username, limit || 5);
        return { results: emails, count: emails.length, query: query || "(recent)" };
      },
    }),

    readEmail: tool({
      description:
        `Read the full body of a specific email by its Gmail message id. Use this after \`searchEmails\` whenever ${name} asks about the contents of a message — summaries, action items, decisions, meeting recordings, long threads. \`searchEmails\` only returns headers + a short snippet; this returns the complete body text.`,
      inputSchema: z.object({
        messageId: z
          .string()
          .describe("The Gmail message id (the `id` field from a searchEmails result)."),
      }),
      execute: async ({ messageId }) => {
        if (!(await isGoogleConnected(username))) {
          return { error: `Gmail not connected. ${name} needs to connect Google in Settings.` };
        }
        try {
          const email = await getEmailBody(username, messageId);
          return email;
        } catch (e) {
          return {
            error: `Failed to fetch email body: ${e instanceof Error ? e.message : "Unknown error"}`,
          };
        }
      },
    }),

    searchSlack: tool({
      description: `Search Slack messages across all channels, DMs, and group DMs. Can search by keyword, person, or channel.`,
      inputSchema: z.object({
        query: z.string().describe("Search query — keywords, person name, or channel name"),
      }),
      execute: async ({ query }) => {
        if (!(await isSlackConnected(username))) {
          return { error: "Slack not connected." };
        }
        const results = await searchSlackMessages(username, query, 10);
        return { results, count: results.length, query };
      },
    }),

    getSlackDMs: tool({
      description: `Get recent direct messages and group DMs from Slack. Use this to check what people have been messaging ${name} directly.`,
      inputSchema: z.object({
        limit: z.number().optional().describe("Max messages to return. Defaults to 10."),
      }),
      execute: async ({ limit }) => {
        if (!(await isSlackConnected(username))) {
          return { error: "Slack not connected." };
        }
        const all = await getRecentSlackMessages(username, limit || 10);
        const dms = all.filter((m) => m.channel.startsWith("DM:") || m.channel === "Group DM");
        return { results: dms, count: dms.length };
      },
    }),

    lookupSlackUser: tool({
      description: "Look up a Slack user's profile by name or email. Returns their title, status, timezone, and email.",
      inputSchema: z.object({
        nameOrEmail: z.string().describe("Person's name or email address"),
      }),
      execute: async ({ nameOrEmail }) => {
        if (!(await isSlackConnected(username))) {
          return { error: "Slack not connected." };
        }
        const profile = await getUserProfile(username, nameOrEmail);
        if (!profile) return { error: `No user found for "${nameOrEmail}"` };
        return profile;
      },
    }),

    searchDrive: tool({
      description: "Search Google Drive for documents by name or content.",
      inputSchema: z.object({
        query: z.string().describe("Search query for Drive documents"),
      }),
      execute: async ({ query }) => {
        if (!(await isGoogleConnected(username))) {
          return { error: `Google Drive not connected. ${name} needs to connect Google in Settings.` };
        }
        const files = await searchDriveFiles(username, query);
        return { results: files, count: files.length };
      },
    }),

    // ── ACTION TOOLS (require approval) ──

    draftEmail: tool({
      description: `Queue an email for ${name} to review and send. Creates a pending approval item — ${name} sees the draft, can edit it, then clicks Send. Always use '${name}' as the sender name. Never bypass this queue to send directly.`,
      inputSchema: z.object({
        to: z.string().describe("Recipient email address"),
        subject: z.string().describe("Email subject"),
        body: z.string().describe("Full email body text"),
      }),
      needsApproval: true,
      execute: async ({ to, subject, body }) => {
        if (!(await isGoogleConnected(username))) {
          return { error: "Gmail not connected. Cannot draft emails until Google is connected in Settings." };
        }
        const result = await createDraft(username, to, subject, body);
        await emitAuditEvent({ username,
          source: "email",
          headline: `Drafted email to ${to}`,
          context: `Subject: ${subject}\n\n${body}`,
          rationale: `${name} approved the draft in chat.`,
          entityName: to,
          tags: ["email", "draft"],
        });
        return { status: "draft_created", draftId: result.id, to, subject, preview: body.substring(0, 100) + "..." };
      },
    }),

    checkAttendeeAvailability: tool({
      description: `Check when attendees are free for a meeting. Always call this BEFORE proposing a time with scheduleMeeting. Returns each person's timezone, working hours, and busy blocks so you can find a slot that works for everyone. If Google Calendar access is limited, still returns timezone and working hours so you can reason about reasonable local times.`,
      inputSchema: z.object({
        attendees: z.array(z.string()).describe("Names or email addresses of people to check. Include all attendees (not ${name} — their own calendar is checked automatically)."),
        date: z.string().describe("Start date to check, YYYY-MM-DD"),
        endDate: z.string().optional().describe("End date for multi-day search, YYYY-MM-DD. Defaults to same as date."),
      }),
      execute: async ({ attendees, date, endDate }) => {
        if (!(await isGoogleConnected(username))) {
          return { error: "Google Calendar not connected — cannot check availability." };
        }

        const checkEndStr = endDate || date;

        // ── Michael's own calendar ────────────────────────────────────────────
        // Use getEventsForDateRange (authenticated primary calendar) rather than
        // freebusy.  This captures Focus time blocks, Reclaim.ai holds, and any
        // event marked "Free" that would be invisible to the freebusy API.
        const myEvents = await getEventsForDateRange(username, date, checkEndStr, timezone).catch(() => []);
        const myBusyBlocks: { start: string; end: string }[] = myEvents
          .filter((e) => !e.isAllDay)
          .map((e) => ({ start: e.start, end: e.end }));

        // ── Resolve each attendee ─────────────────────────────────────────────
        const userContacts = await listUserContacts(username).catch(() => []);
        const slackConnected = await isSlackConnected(username).catch(() => false);

        const resolved = await Promise.all(
          attendees.map(async (a) => {
            const isEmail = a.includes("@");
            const contact = findContactByName(a, userContacts);
            const email = isEmail ? a : contact?.email;
            const locationTz = timezoneFromLocation(contact?.location);

            // Slack profile has the most accurate IANA tz
            let slackTz: string | undefined;
            if (slackConnected) {
              const profile = await getUserProfile(username, email || a).catch(() => null); // ci-ok: optional Slack profile for timezone; slackTz undefined if unavailable
              slackTz = profile?.tz;
            }

            return {
              displayName: contact?.name || a,
              email,
              tz: slackTz || locationTz || "UTC",
            };
          })
        );

        // ── Attendee freebusy via Google Calendar API ─────────────────────────
        const checkStart = new Date(`${date}T00:00:00Z`);
        const checkEnd = new Date(`${checkEndStr}T23:59:59Z`);
        const emailsToCheck = resolved.filter((r) => r.email).map((r) => r.email!);
        const attendeeFB = emailsToCheck.length
          ? await checkFreeBusy(username, emailsToCheck, checkStart, checkEnd).catch(() => [])
          : [];

        const attendeeBusyMap = new Map<string, { start: string; end: string }[]>();
        for (const fb of attendeeFB) {
          attendeeBusyMap.set(fb.email, fb.error ? [] : fb.busy);
        }

        // ── Build per-person summary ──────────────────────────────────────────
        const people = resolved.map((r) => {
          const busy = r.email ? (attendeeBusyMap.get(r.email) ?? []) : [];
          const offsetH = (() => {
            try {
              const ref = new Date(`${date}T12:00:00Z`);
              const utcMs = new Date(ref.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
              const tzMs  = new Date(ref.toLocaleString("en-US", { timeZone: r.tz })).getTime();
              return (tzMs - utcMs) / 3_600_000;
            } catch { return 0; }
          })();
          const sign = offsetH >= 0 ? "+" : "-";
          const absH = Math.abs(offsetH);
          const offsetStr = `UTC${sign}${Math.floor(absH)}${absH % 1 ? `:${String(Math.round((absH % 1) * 60)).padStart(2, "0")}` : ""}`;
          const busyLocal = busy.map((b) => {
            const s = new Date(b.start).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: r.tz });
            const e = new Date(b.end).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: r.tz });
            return `${s}–${e}`;
          });
          return {
            name: r.displayName,
            email: r.email || "unknown",
            timezone: r.tz,
            utcOffset: offsetStr,
            workingHours: "09:00–18:00 local",
            busyToday: busyLocal.length ? busyLocal : ["(calendar not accessible via freebusy)"],
          };
        });

        // Michael's busy summary (in his timezone, for display)
        const michaelBusyLocal = myBusyBlocks.map((b) => {
          const s = new Date(b.start).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: timezone });
          const e = new Date(b.end).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: timezone });
          return `${s}–${e}`;
        });

        // ── Suggest free slots ────────────────────────────────────────────────
        // Combine Michael's real events + attendees' freebusy into one busy list
        const allBusy: { start: string; end: string }[] = [
          ...myBusyBlocks,
          ...attendeeFB.flatMap((fb) => fb.busy),
        ];

        const suggestions: string[] = [];
        // Scan in the user's timezone to reason about working hours correctly
        const scanDate = new Date(`${date}T00:00:00`);
        const tzOffset = (() => {
          try {
            const ref = new Date(`${date}T12:00:00Z`);
            const utcMs = new Date(ref.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
            const tzMs  = new Date(ref.toLocaleString("en-US", { timeZone: timezone })).getTime();
            return (tzMs - utcMs) / 3_600_000;
          } catch { return 0; }
        })();
        // Start scanning at 08:00 in Michael's local timezone
        const windowStartUTC = new Date(new Date(`${date}T08:00:00Z`).getTime() - tzOffset * 3_600_000);
        const windowEndUTC   = new Date(new Date(`${date}T18:00:00Z`).getTime() - tzOffset * 3_600_000);
        void scanDate;

        for (let t = new Date(windowStartUTC); t < windowEndUTC; t = new Date(t.getTime() + 30 * 60_000)) {
          const slotEnd = new Date(t.getTime() + 30 * 60_000);

          // Skip if Michael has any event overlapping this slot
          const michaelBusy = allBusy.some((b) => {
            const bs = new Date(b.start).getTime();
            const be = new Date(b.end).getTime();
            return t.getTime() < be && slotEnd.getTime() > bs;
          });
          if (michaelBusy) continue;

          // Michael's local hour check
          const mHour = parseFloat(
            new Date(t.getTime()).toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: timezone })
          );
          if (mHour < 9 || mHour >= 17) continue;

          // All attendees must be within their working hours
          const allOk = resolved.every((r) => {
            const h = parseFloat(
              new Date(t.getTime()).toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: r.tz })
            );
            return h >= 9 && h < 17;
          });
          if (!allOk) continue;

          const timeStrs = [
            `${new Date(t.getTime()).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: timezone })} (${timezone.split("/")[1] || timezone})`,
            ...resolved.map((r) =>
              `${new Date(t.getTime()).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: r.tz })} (${r.displayName})`
            ),
          ];
          suggestions.push(timeStrs.join(" / "));
        }

        return {
          date,
          michael: {
            timezone,
            busyBlocks: michaelBusyLocal.length ? michaelBusyLocal : ["(free all day)"],
            note: "Fetched directly from primary Google Calendar — includes Focus time and all holds.",
          },
          attendees: people,
          suggestedSlots: suggestions.slice(0, 6),
          note: suggestions.length === 0
            ? "No overlap found within working hours. Consider proposing outside normal hours or checking a different day."
            : `${suggestions.length} free slot(s) found within everyone's working hours.`,
        };
      },
    }),

    scheduleMeeting: tool({
      description: `Schedule a meeting on Google Calendar on ${name}'s behalf. Shows details for approval before booking. IMPORTANT: Always call checkAttendeeAvailability first to verify the proposed time works for all attendees in their local timezones.`,
      inputSchema: z.object({
        title: z.string().describe("Meeting title"),
        attendees: z.array(z.string()).describe("List of attendee email addresses"),
        date: z.string().describe("Date in YYYY-MM-DD format"),
        startTime: z.string().describe(`Start time in HH:MM 24h format in ${name}'s local timezone (${timezone})`),
        duration: z.number().describe("Duration in minutes").default(30),
      }),
      needsApproval: true,
      execute: async ({ title, attendees, date, startTime, duration }) => {
        if (!(await isGoogleConnected(username))) {
          return { error: "Google Calendar not connected. Cannot schedule until Google is connected in Settings." };
        }
        try {
          const result = await createCalendarEvent(username, { title, attendees, date, startTime, duration });
          await emitAuditEvent({ username,
            source: "calendar",
            headline: `Scheduled "${title}" on ${date} ${startTime}`,
            context: `Attendees: ${attendees.join(", ")}\nDuration: ${duration}m\nLink: ${result.htmlLink ?? "(pending)"}`,
            rationale: `${name} approved the meeting in chat.`,
            entityName: attendees[0],
            tags: ["calendar", "scheduled"],
          });
          return {
            status: "meeting_scheduled",
            eventId: result.id,
            htmlLink: result.htmlLink,
            title,
            attendees,
            date,
            time: startTime,
            duration,
          };
        } catch (e) {
          return { error: `Failed to create event: ${e instanceof Error ? e.message : "Unknown error"}` };
        }
      },
    }),

    // ── MEMORY TOOLS ──

    rememberThis: tool({
      description:
        `Store a durable memory about ${name}, a person, an active project, or a preference. `
        + `PROACTIVELY use this whenever ${name} shares something worth retaining across sessions — `
        + `a change in priorities, a new preference, a stance on a decision, context about a person, `
        + `a personal fact, or anything they'd expect you to remember next time. `
        + `Keep each memory as ONE short, specific, self-contained sentence. Dedupe is automatic. `
        + `Do not wait to be asked — if it's worth remembering, save it immediately.`,
      inputSchema: z.object({
        kind: z
          .enum(["fact", "preference", "person", "context"])
          .describe(
            `fact = durable truth about ${name} or their world; `
            + `preference = how ${name} wants things done; `
            + `person = note tied to a specific individual; `
            + `context = active project or situational state`
          ),
        content: z
          .string()
          .describe(
            "The memory itself. One sentence. Specific. Written so it makes sense in isolation, e.g. 'Alice prefers bullet-point summaries over prose.'"
          ),
        entity: z
          .string()
          .optional()
          .describe(
            "Optional entity the memory is about (e.g. a person, a company, or a project)."
          ),
      }),
      execute: async ({ kind, content, entity }) => {
        const memory = await createMemory(username, {
          kind,
          content,
          entity,
          source: "chat",
        });
        return {
          status: "saved",
          id: memory.id,
          kind: memory.kind,
          content: memory.content,
          entity: memory.entity,
        };
      },
    }),

    recallMemory: tool({
      description:
        `Retrieve what you've learned about ${name}, a person, or a project. `
        + `Use this when ${name} mentions someone or something and you want to check whether you have prior notes. `
        + `The memories in your system prompt are already loaded — use this tool only when you need to search for a specific entity or verify freshness.`,
      inputSchema: z.object({
        entity: z
          .string()
          .optional()
          .describe(
            "Filter memories to this entity (e.g. a person or a project). Leave empty to retrieve all memories."
          ),
      }),
      execute: async ({ entity }) => {
        const items = entity
          ? await getMemoriesForEntity(username, entity)
          : await listMemories(username);
        return {
          count: items.length,
          memories: items.map((m) => ({
            id: m.id,
            kind: m.kind,
            content: m.content,
            entity: m.entity,
            updatedAt: m.updatedAt,
          })),
        };
      },
    }),

    forgetMemory: tool({
      description:
        `Delete a stored memory by id. Only use when ${name} explicitly asks to forget something, or when a memory has been explicitly superseded by newer information.`,
      inputSchema: z.object({
        id: z.string().describe("The memory id to delete"),
      }),
      needsApproval: true,
      execute: async ({ id }) => {
        const ok = await deleteMemory(username, id);
        if (ok) {
          await emitAuditEvent({ username,
            source: "manual",
            headline: `Forgot memory ${id.slice(0, 8)}`,
            context: `Memory id ${id} removed from the store.`,
            rationale: `${name} approved the forget action in chat.`,
            tags: ["memory", "deleted"],
          });
        }
        return { status: ok ? "forgotten" : "not_found", id };
      },
    }),

    // ── ACTION TRACKER ──

    listActions: tool({
      description:
        `List the commitments on ${name}'s Action Tracker. These are real open/done/overdue actions surfaced on the Actions page. Use this whenever ${name} asks what's on their list, what's open, what's overdue, or what they owe someone.`,
      inputSchema: z.object({
        status: z
          .enum(["all", "open", "done", "overdue"])
          .optional()
          .describe("Filter by status. Defaults to all."),
      }),
      execute: async ({ status }) => {
        // Reconcile linear-sourced actions with live Linear state before
        // listing, so closed/cancelled/reassigned issues don't masquerade as
        // open commitments. TTL-cached to keep tool latency low.
        await syncLinearActionStates(username).catch(() => { /* non-fatal */ });

        const all = await listActions(username);
        const filter = status ?? "all";
        const items = filter === "all" ? all : all.filter((a) => a.status === filter);
        return {
          count: items.length,
          status: filter,
          actions: items.map((a) => ({
            id: a.id,
            text: a.text,
            owner: a.owner,
            dueDate: a.dueDate,
            status: a.status,
            source: a.source,
            priority: a.priority,
            confidence: a.confidence,
            linkedDecisionIds: a.linkedDecisionIds,
          })),
        };
      },
    }),

    addAction: tool({
      description:
        `Add a new item to ${name}'s Action Tracker. Use when ${name} says something like 'add X to my list', 'remind me to', or when you spot a clear commitment from an email or Slack thread they want captured. Keep \`text\` specific and outcome-oriented. Shows for approval before saving.`,
      inputSchema: z.object({
        text: z.string().describe("The action. One sentence, specific, outcome-oriented."),
        owner: z
          .string()
          .optional()
          .describe(`Person responsible. Defaults to ${name} if omitted.`),
        dueDate: z
          .string()
          .optional()
          .describe("Due date in YYYY-MM-DD. Optional."),
        priority: z
          .enum(["high", "medium", "low"])
          .optional()
          .describe("Urgency level. Use high for time-critical items, low if no urgency. Defaults to medium."),
        source: z
          .enum(["meeting", "slack", "email", "manual", "chat"])
          .optional()
          .describe("Where this action came from. Defaults to chat."),
      }),
      needsApproval: true,
      execute: async ({ text, owner, dueDate, priority, source }) => {
        const ownerId = owner ? findContactByName(owner)?.id : undefined;
        const action = await createAction(username, {
          text,
          owner,
          ownerId,
          dueDate,
          source: source ?? "chat",
          priority,
        });
        await emitAuditEvent({ username,
          source: "manual",
          headline: `Added action: ${action.text.slice(0, 60)}`,
          context: `Owner: ${action.owner}${action.dueDate ? `\nDue: ${action.dueDate}` : ""}`,
          rationale: `${name} approved the action in chat.`,
          tags: ["actions", "added"],
        });
        return { result: "added", action };
      },
    }),

    completeAction: tool({
      description:
        `Mark an action as done. Use when ${name} says they finished something or when a commitment is clearly resolved.`,
      inputSchema: z.object({
        id: z.string().describe("The action id."),
      }),
      execute: async ({ id }) => {
        const updated = await updateAction(username, id, { status: "done" });
        if (!updated) return { result: "not_found", id };
        return { result: "completed", action: updated };
      },
    }),

    removeAction: tool({
      description:
        `Delete an action from the tracker. Use only when ${name} explicitly asks to remove one. Irreversible.`,
      inputSchema: z.object({
        id: z.string().describe("The action id."),
      }),
      needsApproval: true,
      execute: async ({ id }) => {
        const ok = await deleteAction(username, id);
        return { result: ok ? "removed" : "not_found", id };
      },
    }),

    // ── DECISION LOG ──

    listDecisions: tool({
      description:
        `List decisions ${name} has logged. Use when they ask 'what did we decide about X', 'what's the current call on Y', or wants to see recent decisions.`,
      inputSchema: z.object({
        status: z
          .enum(["all", "active", "superseded"])
          .optional()
          .describe("Filter by status. Defaults to all."),
      }),
      execute: async ({ status }) => {
        const all = await listDecisions(username);
        const filter = status ?? "all";
        const items = filter === "all" ? all : all.filter((d) => d.status === filter);
        return {
          count: items.length,
          status: filter,
          decisions: items.map((d) => ({
            id: d.id,
            title: d.title,
            text: d.text,
            decidedBy: d.decidedBy,
            stakeholders: d.stakeholders,
            date: d.date,
            context: d.context,
            status: d.status,
            source: d.source,
            confidence: d.confidence,
            rationale: d.rationale,
            consequences: d.consequences,
            linkedActionIds: d.linkedActionIds,
          })),
        };
      },
    }),

    logDecision: tool({
      description:
        `Log a new decision to ${name}'s Decision Log. Use when ${name} says something was decided, or when a thread clearly reached a call they want captured. Shows for approval before saving.`,
      inputSchema: z.object({
        text: z.string().describe("What was decided. One crisp sentence."),
        title: z
          .string()
          .optional()
          .describe("Short (≤8 word) scannable headline — omit if you can't form one cleanly."),
        decidedBy: z.string().describe("Who made the call (person or group)."),
        stakeholders: z
          .array(z.string())
          .optional()
          .describe("Other people affected or consulted (names)."),
        date: z
          .string()
          .optional()
          .describe("Date in YYYY-MM-DD. If omitting, use today's date from the '## Right Now' section of your system prompt — do NOT guess from training data."),
        context: z
          .string()
          .optional()
          .describe("Short note on source/context (e.g. 'Slack #ap-launch')."),
        rationale: z
          .string()
          .optional()
          .describe("Why this decision was made — only if explicitly stated or known."),
        alternatives: z
          .array(z.string())
          .optional()
          .describe("Options that were explicitly considered and rejected."),
        consequences: z
          .array(z.string())
          .optional()
          .describe("Direct follow-up commitments or implications tied to this decision."),
      }),
      needsApproval: true,
      execute: async ({ text, title, decidedBy, stakeholders, date, context, rationale, alternatives, consequences }) => {
        const decidedById = findContactByName(decidedBy)?.id;
        const decision = await createDecision(username, {
          text,
          title,
          decidedBy,
          decidedById,
          stakeholders,
          date,
          context,
          source: "chat",
          rationale,
          alternatives,
          consequences,
        });
        await emitAuditEvent({ username,
          source: "manual",
          headline: `Logged decision: ${(decision.title ?? decision.text).slice(0, 60)}`,
          context: `Decided by ${decision.decidedBy} on ${decision.date}${decision.context ? `\n${decision.context}` : ""}${rationale ? `\nRationale: ${rationale}` : ""}`,
          rationale: `${name} approved the decision log entry in chat.`,
          entityName: decidedBy,
          tags: ["decisions", "logged"],
        });
        return { result: "logged", decision };
      },
    }),

    supersedeDecision: tool({
      description:
        "Mark a decision as superseded (no longer the active call). Use when a new decision overrides an older one.",
      inputSchema: z.object({
        id: z.string().describe("The decision id."),
      }),
      needsApproval: true,
      execute: async ({ id }) => {
        const updated = await updateDecision(username, id, { status: "superseded" });
        if (!updated) return { result: "not_found", id };
        return { result: "superseded", decision: updated };
      },
    }),

    generateContactProfile: tool({
      description:
        `Generate a personality profile for a contact. Pulls Gmail, Slack, and Zoom signals for the person and writes a profile. Use when ${name} asks for a read on someone, wants to learn about a new contact, or wants a profile refreshed. The draft is returned for ${name} to review and save from the Contacts page.`,
      inputSchema: z.object({
        name: z.string().describe("The contact's full name."),
        email: z
          .string()
          .optional()
          .describe("Their email, if known — sharpens the Gmail search."),
        directory: z
          .enum(["work", "personal"])
          .optional()
          .describe(
            "work = colleague/investor/client (Gmail/Slack signal); personal = friend/family (notes-driven). Defaults to work."
          ),
        notes: z
          .string()
          .optional()
          .describe(
            `Freeform notes ${name} has about this person (how they met, what they care about, context). Primary signal for personal contacts.`
          ),
      }),
      execute: async ({ name: contactName, email, directory, notes }) => {
        try {
          const origin = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3002";
          const res = await fetch(`${origin}/api/contacts/generate-profile`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: contactName, email, directory, notes, username }),
          });
          if (!res.ok) {
            return { error: `Profile generator failed (${res.status})` };
          }
          const data = (await res.json()) as {
            personality?: string;
            whatMakesThemTick?: string;
            watchOut?: string;
            recentActivity?: string;
            activitySource?: string;
            signalCount?: number;
            summary?: string;
            error?: string;
          };
          if (data.error) return { error: data.error };
          return {
            status: "drafted",
            note: `Draft generated. ${name} can save it from the Contacts page.`,
            ...data,
          };
        } catch (e) {
          return {
            error: `Failed to generate profile: ${e instanceof Error ? e.message : "unknown"}`,
          };
        }
      },
    }),

    sendSlackMessage: tool({
      description: `Send a message on Slack on ${name}'s behalf. Can send to channels (#channel-name) or DM a person by name. Shows message for approval before sending.`,
      inputSchema: z.object({
        channel: z.string().describe("Channel name (e.g., #general) or person's name for DM (e.g., Alice Smith)"),
        message: z.string().describe("Message to send"),
      }),
      needsApproval: true,
      execute: async ({ channel, message }) => {
        if (!(await isSlackConnected(username))) {
          return { error: "Slack not connected. Cannot send messages until Slack is configured in Settings." };
        }
        const result = await slackSend(username, channel, message);
        if (result.ok) {
          await emitAuditEvent({ username,
            source: "slack",
            headline: `Sent Slack message to ${channel}`,
            context: message,
            rationale: `${name} approved the Slack message in chat.`,
            entityName: channel,
            tags: ["slack", "sent"],
          });
          return { status: "message_sent", channel, preview: message.substring(0, 100) };
        }
        return { status: "failed", error: result.error };
      },
    }),

    // ── LINEAR TOOLS ─────────────────────────────────────────────────────────

    listLinearIssues: tool({
      description: `List Linear issues across ${name}'s workspace. Use when ${name} asks about Linear issues, tickets, what's in progress, what's blocked, or the status of work. Returns each issue's identifier (e.g. "ANA-135"), title, status, assignee, team, and priority. By default returns NOT-done issues (the actionable ones); pass includeCompleted to also list done/cancelled.`,
      inputSchema: z.object({
        statusType: z
          .enum(["all", "started", "unstarted", "triage", "completed"])
          .optional()
          .describe('Filter by Linear state type: "started" (In Progress), "unstarted" (Todo), "triage" (Backlog), "completed" (Done). Omit for all not-done issues.'),
        assignedToMe: z.boolean().optional().describe(`Only ${name}'s assigned issues. Defaults to false (whole workspace).`),
        includeCompleted: z.boolean().optional().describe("Include done/cancelled issues. Defaults to false."),
      }),
      execute: async ({ statusType, assignedToMe, includeCompleted }) => {
        if (!(await isLinearConnected(username))) {
          return { error: "Linear not connected. Connect it in Settings to manage issues." };
        }
        const all = await getAllIssues(username, {
          ...(statusType && statusType !== "all" ? { stateType: statusType } : {}),
          ...(assignedToMe ? { assigneeIsMe: true } : {}),
        });
        const visible = includeCompleted
          ? all
          : all.filter((i) => i.state.type !== "completed" && i.state.type !== "cancelled");
        return {
          count: visible.length,
          issues: visible.slice(0, 40).map((i) => ({
            identifier: i.identifier,
            title: i.title,
            status: i.state.name,
            statusType: i.state.type,
            assignee: i.assignee?.name ?? "Unassigned",
            team: i.team.name,
            priority: i.priority,
            url: i.url,
          })),
        };
      },
    }),

    updateLinearIssueStatus: tool({
      description: `Change the status of a Linear issue. Use when ${name} asks to move, close, reopen, or update the status of a Linear issue — e.g. "mark ANA-135 done", "move the sentiment graph bug to In Progress". Identify the issue by its identifier (e.g. "ANA-135"). Shows the change for approval before applying.`,
      inputSchema: z.object({
        identifier: z.string().describe('The Linear issue identifier, e.g. "ANA-135".'),
        targetStatus: z.string().describe('The status to move it to, e.g. "Done", "In Progress", "Todo", "Backlog", "Cancelled". Matched against the team\'s workflow states.'),
      }),
      needsApproval: true,
      execute: async ({ identifier, targetStatus }) => {
        if (!(await isLinearConnected(username))) {
          return { error: "Linear not connected." };
        }
        // 1. Find the issue by identifier across the workspace.
        const all = await getAllIssues(username);
        const issue = all.find((i) => i.identifier.toLowerCase() === identifier.toLowerCase());
        if (!issue) {
          return { status: "not_found", error: `No Linear issue found with identifier "${identifier}".` };
        }
        // 2. Resolve the target state for the issue's team.
        const states = await getWorkflowStates(username, issue.team.id);
        const want = targetStatus.trim().toLowerCase();
        // Match by name first, then by common synonyms → state type.
        const synonymType: Record<string, string> = {
          done: "completed", complete: "completed", completed: "completed", closed: "completed",
          "in progress": "started", started: "started", doing: "started", "in-progress": "started",
          todo: "unstarted", "to do": "unstarted", unstarted: "unstarted",
          backlog: "triage", triage: "triage",
          cancelled: "cancelled", canceled: "cancelled",
        };
        const target =
          states.find((s) => s.name.toLowerCase() === want) ??
          states.find((s) => s.type === synonymType[want]);
        if (!target) {
          return {
            status: "invalid_status",
            error: `Could not find a "${targetStatus}" state for team ${issue.team.name}.`,
            availableStates: states.map((s) => s.name),
          };
        }
        // 3. Apply the change.
        try {
          const updated = await updateLinearIssue(username, issue.id, { stateId: target.id });
          await emitAuditEvent({
            username,
            source: "manual",
            headline: `Moved ${issue.identifier} to ${target.name}`,
            context: `${issue.title}\nFrom: ${issue.state.name} → ${target.name}`,
            rationale: `${name} approved the Linear status change in chat.`,
            entityName: issue.identifier,
            tags: ["linear", "status-change", target.type],
          });
          return {
            status: "updated",
            identifier: updated.identifier,
            title: updated.title,
            newStatus: target.name,
            url: updated.url,
          };
        } catch (e) {
          return { status: "failed", error: e instanceof Error ? e.message : String(e) };
        }
      },
    }),

    // ── WEB SEARCH TOOLS ─────────────────────────────────────────────────────

    searchWeb: tool({
      description: `Search the web for current information. Use this when ${name} asks about something you don't know, needs up-to-date facts, wants research on a company or person, needs market intelligence, or asks about recent news or events. Prefer this over guessing when current or external information is needed.`,
      inputSchema: z.object({
        query: z.string().describe(
          "The search query. Be specific — include company names, dates, or context for better results."
        ),
        depth: z
          .enum(["basic", "advanced"])
          .optional()
          .describe(
            "Search depth. Use 'basic' (default) for quick lookups; 'advanced' for deep research on complex topics."
          ),
      }),
      execute: async ({ query, depth = "basic" }) => {
        const res = await webSearch(query, { maxResults: 5, depth, includeAnswer: true });
        if (res.error) {
          return { error: res.error, configured: !res.error.includes("not configured") };
        }
        return {
          query: res.query,
          answer: res.answer,
          results: res.results.map((r) => ({
            title: r.title,
            url: r.url,
            snippet: r.content,
          })),
          resultCount: res.results.length,
        };
      },
    }),

    readWebPage: tool({
      description: `Fetch and read the full text content of a specific web page or URL. Use this when ${name} shares a link and wants you to read it, or when a search result needs deeper reading to answer a question. Do NOT use this for general searches — use searchWeb instead.`,
      inputSchema: z.object({
        url: z.string().url().describe("The full URL of the page to read."),
      }),
      execute: async ({ url }) => {
        const res = await fetchPageContent(url);
        if (res.error) {
          return { error: res.error, url };
        }
        return {
          url: res.url,
          content: res.content,
          wordCount: res.content.split(/\s+/).length,
        };
      },
    }),
  };
}
