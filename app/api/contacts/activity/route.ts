import { NextResponse } from "next/server";
import { getEventsForDays, getEventsForMonth } from "@/lib/google/calendar";
import { searchEmails } from "@/lib/google/gmail";
import { getRecentDriveActivity } from "@/lib/google/drive";
import { getRecentSlackMessages } from "@/lib/slack/client";
import { listMemories } from "@/lib/memory/store";
import { getSessionUser } from "@/lib/auth";
import { contacts } from "@/lib/contacts-data";

/**
 * GET /api/contacts/activity
 *
 * Computes real `lastInteraction` dates for each contact by cross-referencing
 * live calendar events, email threads, and Slack messages from the last 30 days.
 * Returns an enriched contact activity map that the frontend can use to update
 * the relationship heat map in real time.
 */

interface ContactActivity {
  contactId: string;
  name: string;
  lastInteraction: string | null; // ISO date string
  sources: string[];
  recentItems: string[];
}

function nameMatchesContact(
  text: string,
  contactName: string
): boolean {
  const textLower = text.toLowerCase();
  const nameLower = contactName.toLowerCase();

  // Full name match
  if (textLower.includes(nameLower)) return true;

  // First name match (only if name part is > 2 chars to avoid false positives)
  const parts = nameLower.split(" ");
  return parts.some((part) => part.length > 2 && textLower.includes(part));
}

export async function GET() {
  const username = (await getSessionUser());
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();

  // 30-day window (declared early so it's available in the parallel fetch)
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  // Fetch all data sources in parallel
  const [calendarEvents, emails, slackMessages, driveActivity, zoomPersonMemories] =
    await Promise.all([
      (async () => {
        try {
          // Get current and previous month to cover ~30 days
          const current = await getEventsForMonth(username, currentYear, currentMonth);
          const prevMonth = currentMonth === 0 ? 11 : currentMonth - 1;
          const prevYear = currentMonth === 0 ? currentYear - 1 : currentYear;
          const prev = await getEventsForMonth(username, prevYear, prevMonth);
          return [...prev, ...current];
        } catch (e) {
          console.error("Calendar fetch failed:", e);
          return [];
        }
      })(),
      searchEmails(username, "in:inbox OR in:sent", 200).catch((e) => {
        console.error("Email fetch failed:", e);
        return [];
      }),
      getRecentSlackMessages(username, 200, 30).catch((e) => {
        console.error("Slack fetch failed:", e);
        return [];
      }),
      getRecentDriveActivity(username, 30, 100).catch((e) => {
        console.error("Drive activity fetch failed:", e);
        return [];
      }),
      // Memory store: "person" memories written by the Zoom materialization path.
      // These represent actual meeting participants, not incidental text mentions.
      // Content format: 'Zoom meeting participant: "{title}" on YYYY-MM-DD.'
      listMemories(username).then((all) =>
        all.filter(
          (m) =>
            m.kind === "person" &&
            m.entity &&
            /^Zoom meeting participant:/i.test(m.content) &&
            new Date(m.updatedAt).getTime() > thirtyDaysAgo.getTime()
        )
      ).catch((e) => {
        console.error("Memory fetch failed:", e);
        return [];
      }),
    ]);

  // Compute activity for each contact
  const activityMap: ContactActivity[] = contacts.map((contact) => {
    const interactions: { date: string; source: string; description: string }[] =
      [];
    const sources = new Set<string>();

    // Calendar: check if contact name appears in attendees.
    // If the event had a Zoom/video link AND is in the past, label the source
    // as "Zoom" so the relationship tracker can surface video-call cadence
    // distinctly from one-off invites.
    const nowMs = Date.now();
    for (const event of calendarEvents) {
      const eventDate = (event.start || "").substring(0, 10);
      if (!eventDate || new Date(eventDate) < thirtyDaysAgo) continue;

      const attendeeMatch = event.attendees.some((attendee) =>
        nameMatchesContact(attendee, contact.name)
      );
      const summaryMatch = nameMatchesContact(event.summary, contact.name);

      if (attendeeMatch || summaryMatch) {
        const isPastVideoCall =
          event.hasVideo && new Date(event.end || event.start).getTime() < nowMs;
        const source = isPastVideoCall ? "Zoom" : "Calendar";
        interactions.push({
          date: eventDate,
          source,
          description: `${isPastVideoCall ? "Zoom call" : "Meeting"}: ${event.summary}`,
        });
        sources.add(source);
      }
    }

    // Drive/Docs: contact edited a shared document in the last 30 days.
    // Detected via lastModifyingUser.displayName (self-edits already filtered out).
    for (const activity of driveActivity) {
      const activityDate = (activity.modifiedTime || "").substring(0, 10);
      if (!activityDate || new Date(activityDate) < thirtyDaysAgo) continue;

      if (nameMatchesContact(activity.lastModifyingUser, contact.name)) {
        interactions.push({
          date: activityDate,
          source: "Docs",
          description: `${activity.type}: ${activity.fileName}`,
        });
        sources.add("Docs");
      }
    }

    // Email: check sender (received) and recipient (sent) fields
    for (const email of emails) {
      const emailDate = email.date.substring(0, 10);
      if (!emailDate || new Date(emailDate) < thirtyDaysAgo) continue;

      const fromMatch = nameMatchesContact(email.from, contact.name);
      const toMatch = nameMatchesContact(email.to, contact.name);

      if (fromMatch || toMatch) {
        interactions.push({
          date: emailDate,
          source: "Email",
          description: `Email: ${email.subject}`,
        });
        sources.add("Email");
      }
    }

    // Slack: check author, text mentions, and DM channel members (catches outbound DMs)
    for (const msg of slackMessages) {
      const msgDate = msg.date.substring(0, 10);
      if (!msgDate || new Date(msgDate) < thirtyDaysAgo) continue;

      const authorMatch = nameMatchesContact(msg.author, contact.name);
      const textMatch = nameMatchesContact(msg.text, contact.name);
      // channelMembers contains first names of DM participants — matches outbound DMs to this contact
      const dmMatch =
        msg.channelMembers?.some((m) =>
          nameMatchesContact(m, contact.name)
        ) ?? false;

      if (authorMatch || textMatch || dmMatch) {
        interactions.push({
          date: msgDate,
          source: "Slack",
          description: `Slack (${msg.channel}): ${msg.text.substring(0, 80)}`,
        });
        sources.add("Slack");
      }
    }

    // Zoom (via memory store): person memories created during Zoom email
    // materialization.  Each entry represents a confirmed meeting participant
    // — not an incidental mention.  Entity field holds the attendee's name.
    for (const mem of zoomPersonMemories) {
      if (!mem.entity) continue;
      // Match: does the memory's entity (attendee name) refer to this contact?
      if (!nameMatchesContact(mem.entity, contact.name)) continue;
      // Extract the actual meeting date from the structured content.
      // Format: 'Zoom meeting participant: "{title}" on YYYY-MM-DD.'
      const dateMatch = mem.content.match(/on (\d{4}-\d{2}-\d{2})\./);
      const meetingDate = dateMatch ? dateMatch[1] : mem.updatedAt.substring(0, 10);
      // Build a readable description: strip the "Zoom meeting participant: " prefix
      const description = mem.content
        .replace(/^Zoom meeting participant:\s*/i, "Zoom: ")
        .replace(/\.$/, "");
      interactions.push({
        date: meetingDate,
        source: "Zoom",
        description,
      });
      sources.add("Zoom");
    }

    // Sort by date desc and get the most recent
    interactions.sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );

    const lastInteraction =
      interactions.length > 0 ? interactions[0].date : contact.lastInteraction || null;

    return {
      contactId: contact.id,
      name: contact.name,
      lastInteraction,
      sources: Array.from(sources),
      recentItems: interactions.slice(0, 5).map((i) => i.description),
    };
  });

  return NextResponse.json({
    activity: activityMap,
    fetchedAt: now.toISOString(),
    dataSources: {
      calendarEvents: calendarEvents.length,
      emails: emails.length,
      slackMessages: slackMessages.length,
      driveFiles: driveActivity.length,
      zoomMeetings: zoomPersonMemories.length,
    },
  });
}
