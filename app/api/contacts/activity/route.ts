import { NextResponse } from "next/server";
import { getEventsForMonth } from "@/lib/google/calendar";
import { searchEmails } from "@/lib/google/gmail";
import { getRecentDriveActivity } from "@/lib/google/drive";
import { getRecentSlackMessages } from "@/lib/slack/client";
import { listMemories } from "@/lib/memory/store";
import { getRecentLinearActivity } from "@/lib/linear/client";
import { getSessionUser } from "@/lib/auth";
import { listUserContacts } from "@/lib/contacts/user-store";
import { contacts as staticContacts } from "@/lib/contacts-data";
import type { Contact } from "@/lib/contacts-data";

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
  /** Number of confirmed Zoom meetings with this contact in the last 30 days. */
  zoomMeetingCount: number;
  /** Human-readable Zoom meeting cadence, e.g. "weekly", "bi-weekly", or null if no meetings. */
  zoomCadence: string | null;
  /** Total interactions across all sources in the last 30 days. */
  totalInteractionCount: number;
}

// ── Nickname lookup ────────────────────────────────────────────────────────────
// Maps canonical first name → common abbreviations and nicknames.
// Used so "Chris" matches "Christopher Walton", "Ed" matches "Edward", etc.
const NICKNAMES: Record<string, string[]> = {
  christopher: ["chris"],
  christian:   ["chris"],
  william:     ["will", "bill", "billy"],
  robert:      ["rob", "bob", "bobby"],
  richard:     ["rick", "rich"],
  michael:     ["mike", "mick"],
  james:       ["jim", "jimmy"],
  thomas:      ["tom", "tommy"],
  edward:      ["ed", "eddie", "ned"],
  daniel:      ["dan", "danny"],
  alexander:   ["alex"],
  nicholas:    ["nick"],
  matthew:     ["matt"],
  anthony:     ["tony"],
  jonathan:    ["jon", "jonny"],
  benjamin:    ["ben"],
  stephen:     ["steve"],
  steven:      ["steve"],
  nathaniel:   ["nate"],
  theodore:    ["theo", "ted"],
  elizabeth:   ["liz", "beth", "betty"],
  jennifer:    ["jen", "jenny"],
  katherine:   ["kate", "kathy", "kat"],
  catherine:   ["cate", "cathy"],
  deborah:     ["deb"],
  barbara:     ["barb"],
  patricia:    ["pat", "patty"],
};

// Reverse map: nickname → [full names it could expand to]
const NICK_TO_FULL: Record<string, string[]> = {};
for (const [full, nicks] of Object.entries(NICKNAMES)) {
  for (const nick of nicks) {
    (NICK_TO_FULL[nick] ??= []).push(full);
  }
}

/**
 * Returns true if `text` (an attendee name, email sender, Slack author, etc.)
 * refers to the person named `contactName`.
 *
 * Handles:
 *  - Exact/substring:  "Christopher Walton" ↔ "Christopher Walton"
 *  - Partial name:     "christopher.walton@company.com" matches "Christopher Walton"
 *  - Last name:        "Walton" matches "Christopher Walton"
 *  - Prefix nickname:  "Chris" matches "Christopher" (first name starts with text word)
 *  - Explicit nickname:"Bob" matches "Robert", "Ed" matches "Edward"
 */
/**
 * Returns true if `text` (an attendee name, email sender, Slack author, etc.)
 * refers to the person named `contactName`.
 *
 * Handles:
 *  - Exact/substring:     "Christopher Walton" ↔ "Christopher Walton"
 *  - First name only:     "Malcolm" matches "Malcolm Frank"
 *  - Partial name:        "christopher.walton@company.com" matches "Christopher Walton"
 *  - Last name:           "Walton" matches "Christopher Walton"
 *  - Prefix nickname:     "Chris" matches "Christopher" (first name starts with text word)
 *  - Explicit nickname:   "Bob" matches "Robert", "Ed" matches "Edward"
 *  - Contact email:       "malcolm@talentgenius.io" matches when contactEmail provided
 */
function nameMatchesContact(text: string, contactName: string, contactEmail?: string): boolean {
  if (!text || !contactName) return false;
  const textLower  = text.toLowerCase().trim();
  const nameLower  = contactName.toLowerCase().trim();

  // 0. Direct email address match — fastest path, bypasses all name logic
  if (contactEmail) {
    const ce = contactEmail.toLowerCase();
    if (textLower.includes(ce)) return true;
  }

  // 1. Full name substring
  if (textLower.includes(nameLower)) return true;

  const nameParts  = nameLower.split(/\s+/);
  const firstName  = nameParts[0];
  const lastName   = nameParts[nameParts.length - 1];

  // 2. Last name (length > 3 to avoid short surnames causing false positives)
  if (lastName && lastName.length > 3 && textLower.includes(lastName)) return true;

  // 3. Every part of contact name appears in the text
  if (nameParts.length > 1 && nameParts.every((p) => p.length > 2 && textLower.includes(p))) return true;

  // 4. Split text into word tokens for individual word checks
  const textWords = textLower.split(/[\s,@.()\-]+/).filter((w) => w.length >= 2);

  for (const word of textWords) {
    // 5. Exact first-name match: e.g. Slack author "Malcolm" ↔ "Malcolm Frank"
    //    (firstName.length > word.length would exclude this, hence a separate check)
    if (word === firstName && firstName.length >= 3) return true;

    // 6. Prefix match: text word is a prefix of contact's first name
    //    e.g. "chris" → firstName="christopher" → "christopher".startsWith("chris") ✓
    if (firstName.length > word.length && firstName.startsWith(word) && word.length >= 3) return true;

    // 7. Reverse prefix: contact first name is a prefix of text word
    //    e.g. firstName="ed", word="edwards" → "edwards".startsWith("ed") && len>2
    if (word.length > firstName.length && word.startsWith(firstName) && firstName.length >= 3) return true;

    // 8. Explicit nickname: text word is a known nickname for contact's first name
    if ((NICKNAMES[firstName] ?? []).includes(word)) return true;

    // 9. Reverse nickname: text word expands to contact's first name
    if ((NICK_TO_FULL[word] ?? []).includes(firstName)) return true;
  }

  return false;
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
  const [calendarEvents, emails, slackMessages, driveActivity, zoomPersonMemories, linearActivity] =
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
      // Linear: recently updated issues with assignee/creator info.
      // Provides a signal when a contact is active on shared work items.
      getRecentLinearActivity(username, 30).catch((e) => {
        console.error("Linear fetch failed:", e);
        return [];
      }),
    ]);

  // Merge static contacts with user-added contacts (WhatsApp imports, manual entries)
  // Deduplicate by name (case-insensitive) — prefer static contact if both exist.
  const userContacts = await listUserContacts(username).catch(() => [] as Contact[]);
  const staticNames = new Set(staticContacts.map((c) => c.name.toLowerCase()));
  const extraContacts = userContacts.filter(
    (c) => !staticNames.has(c.name.toLowerCase())
  );
  const contacts = [...staticContacts, ...extraContacts];

  // Compute activity for each contact
  const activityMap: ContactActivity[] = contacts.map((contact) => {
    const interactions: { date: string; source: string; description: string }[] =
      [];
    const sources = new Set<string>();

    // Resolve this contact's email address (used for direct matching below)
    const contactEmail = (contact as { email?: string }).email?.toLowerCase() ?? "";

    // Helper that wraps nameMatchesContact with this contact's email address so
    // all call-sites benefit from email-address matching without repetition.
    const matchesContact = (text: string) =>
      nameMatchesContact(text, contact.name, contactEmail || undefined);

    // Calendar: check if contact name appears in attendees.
    // If the event had a Zoom/video link AND is in the past, label the source
    // as "Zoom" so the relationship tracker can surface video-call cadence
    // distinctly from one-off invites.
    const nowMs = Date.now();
    for (const event of calendarEvents) {
      const eventDate = (event.start || "").substring(0, 10);
      if (!eventDate || new Date(eventDate) < thirtyDaysAgo) continue;

      // Attendees may be display names ("Malcolm Frank") or email addresses
      // ("malcolm@talentgenius.io") — matchesContact handles both via email+name paths.
      const attendeeMatch = event.attendees.some((attendee) => matchesContact(attendee));
      const summaryMatch = matchesContact(event.summary);

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

      if (matchesContact(activity.lastModifyingUser)) {
        interactions.push({
          date: activityDate,
          source: "Docs",
          description: `${activity.type}: ${activity.fileName}`,
        });
        sources.add("Docs");
      }
    }

    // Email: check sender (received) and recipient (sent) fields.
    // Uses both direct email address matching (fromEmail / To header) and
    // fuzzy name matching as a fallback.
    for (const email of emails) {
      const emailDate = email.date.substring(0, 10);
      if (!emailDate || new Date(emailDate) < thirtyDaysAgo) continue;

      // Direct email address match: fromEmail is the parsed address (e.g. "malcolm@talentgenius.io")
      const fromEmailMatch = contactEmail
        ? (email.fromEmail?.toLowerCase() ?? "").includes(contactEmail)
        : false;
      // Check if contact's email appears anywhere in the To header (sent mails)
      const toEmailMatch = contactEmail
        ? (email.to?.toLowerCase() ?? "").includes(contactEmail)
        : false;
      // Name-based fallback (for contacts without an email field, or unusual address formats)
      const fromNameMatch = !fromEmailMatch && matchesContact(email.from);
      const toNameMatch = !toEmailMatch && matchesContact(email.to);

      if (fromEmailMatch || toEmailMatch || fromNameMatch || toNameMatch) {
        interactions.push({
          date: emailDate,
          source: "Email",
          description: `Email: ${email.subject}`,
        });
        sources.add("Email");
      }
    }

    // Slack: check author, text mentions, and DM channel members (catches outbound DMs).
    // channelMembers for DMs are stored as lowercase first names (e.g. ["malcolm"]) —
    // matchesContact handles exact-first-name matching via the updated nameMatchesContact.
    for (const msg of slackMessages) {
      const msgDate = msg.date.substring(0, 10);
      if (!msgDate || new Date(msgDate) < thirtyDaysAgo) continue;

      const authorMatch = matchesContact(msg.author);
      const textMatch = matchesContact(msg.text);
      // channelMembers contains first names of DM participants — matches outbound DMs to this contact
      const dmMatch =
        msg.channelMembers?.some((m) => matchesContact(m)) ?? false;

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
      if (!matchesContact(mem.entity)) continue;
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

    // Linear: contact appears as assignee or creator of a recently updated issue.
    // This surfaces shared work-item activity as a relationship signal.
    for (const entry of linearActivity) {
      const entryDate = entry.updatedAt.substring(0, 10);
      if (!entryDate || new Date(entryDate) < thirtyDaysAgo) continue;

      if (nameMatchesContact(entry.personName, contact.name, entry.personEmail || contactEmail || undefined)) {
        interactions.push({
          date: entryDate,
          source: "Linear",
          description: entry.description,
        });
        sources.add("Linear");
      }
    }

    // Sort by date desc and get the most recent
    interactions.sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );

    const lastInteraction =
      interactions.length > 0 ? interactions[0].date : contact.lastInteraction || null;

    // ── Zoom meeting cadence ──────────────────────────────────────────────────
    // Count confirmed Zoom meetings (from memory store + calendar video calls)
    // in the last 30 days and derive a human-readable cadence label.
    const zoomInteractions = interactions.filter(
      (i) => i.source === "Zoom"
    );
    const zoomMeetingCount = zoomInteractions.length;

    // Cadence: meetings per 30-day window expressed as a readable label.
    // Thresholds: ≥8 = "2×/week", ≥4 = "weekly", ≥2 = "bi-weekly", ≥1 = "monthly", 0 = "inactive"
    const zoomCadence =
      zoomMeetingCount >= 8 ? "2×/week"
      : zoomMeetingCount >= 4 ? "weekly"
      : zoomMeetingCount >= 2 ? "bi-weekly"
      : zoomMeetingCount >= 1 ? "monthly"
      : null;

    // Total interaction count across all sources (useful for relationship heat)
    const totalInteractionCount = interactions.length;

    return {
      contactId: contact.id,
      name: contact.name,
      lastInteraction,
      sources: Array.from(sources),
      recentItems: interactions.slice(0, 5).map((i) => i.description),
      zoomMeetingCount,
      zoomCadence,
      totalInteractionCount,
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
      linearItems: linearActivity.length,
    },
  });
}
