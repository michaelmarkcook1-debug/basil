import { NextResponse } from "next/server";
import { replaceAll } from "@/lib/events/store";
import { eventFromIngest } from "@/lib/events/rules";
import type { IngestPayload, BasilEvent } from "@/lib/events/types";
import { getSessionUser } from "@/lib/auth";
import { isAdminUser } from "@/lib/users";

// Realistic scenarios seeded into Basil so the dashboard has something to show
// before real Gmail/Slack/Calendar push is wired up.
const SEED: IngestPayload[] = [
  {
    source: "email",
    title: "Example Analytics v1.0 launch — final sign off needed",
    body: "Hi Michael, the team is ready. Can you review the launch deck and confirm we ship Friday? I've attached the go-to-market doc and pricing page mock. —Jordan Avery",
    from: "Jordan Avery",
    hints: { isFromKeyPerson: true },
  },
  {
    source: "slack",
    title: "DM from Sam Rivera",
    body: "quick one — ok if I move the Example Analytics product review from Thursday to Tuesday? Riley Chen has a conflict",
    from: "Sam Rivera",
    channel: "DM: Sam Rivera",
    hints: { isDM: true, isFromKeyPerson: true },
  },
  {
    source: "slack",
    title: "Group DM: Jordan Avery + Sam Rivera",
    body: "michael, both of us free tomorrow 2pm if you want to sync on the Example Holdings naming decision",
    from: "Jordan Avery",
    channel: "Group DM: Jordan Avery, Sam Rivera",
    hints: { isGroupDM: true, isFromKeyPerson: true },
  },
  {
    source: "email",
    title: "Invoice from Anthropic — $8,400 due 2026-04-22",
    body: "Your April usage invoice for the Claude API is attached. Payment due within 10 days. Reply to finance@anthropic.com with questions.",
    from: "billing@anthropic.com",
  },
  {
    source: "slack",
    title: "#exec channel",
    body: "@here heads up — legal flagged the Example Talent marketplace contract. need to review before we sign with Avery Quinn's team.",
    from: "Sam Jordan",
    channel: "#exec",
    hints: { isMention: true },
  },
  {
    source: "calendar",
    title: "Product Review moved to Tuesday 3pm",
    body: "Riley Chen moved the Example Analytics Product Review. Two hours earlier than originally scheduled.",
    from: "Riley Chen",
  },
  {
    source: "drive",
    title: "Avery Quinn edited 'Example Talent GTM Plan v3'",
    body: "Added new competitive landscape section and a revised rollout timeline. No questions posted — clean edit.",
    from: "Avery Quinn",
  },
  {
    source: "slack",
    title: "#example-analytics-launch",
    body: "Action item for Michael: confirm pricing tier names by EOD Wednesday. Owner: Michael. Due: 2026-04-16",
    from: "Casey Morgan",
    channel: "#example-analytics-launch",
  },
];

/**
 * POST /api/events/seed — reset the event store to the canonical demo set.
 * Useful on a fresh checkout or when iterating on rules. Not wired to the UI.
 */
export async function POST() {
  const username = await getSessionUser();
  if (!username || !isAdminUser(username)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const now = Date.now();
  const events: BasilEvent[] = SEED.map((p, idx) => {
    const shaped = eventFromIngest(p);
    // Stagger timestamps so the feed has a realistic spread (most recent first).
    const createdAt = new Date(now - idx * 1000 * 60 * 37).toISOString();
    return {
      ...shaped,
      id: `seed-${idx + 1}`,
      createdAt,
      updatedAt: createdAt,
    };
  });
  await replaceAll(username, events);
  return NextResponse.json({ seeded: events.length, events });
}
