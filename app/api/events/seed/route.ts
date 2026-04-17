import { NextResponse } from "next/server";
import { replaceAll } from "@/lib/events/store";
import { eventFromIngest } from "@/lib/events/rules";
import type { IngestPayload, BasilEvent } from "@/lib/events/types";

// Realistic scenarios seeded into Basil so the dashboard has something to show
// before real Gmail/Slack/Calendar push is wired up.
const SEED: IngestPayload[] = [
  {
    source: "email",
    title: "AG v1.0 launch — final sign off needed",
    body: "Hi Michael, the team is ready. Can you review the launch deck and confirm we ship Friday? I've attached the go-to-market doc and pricing page mock. —Malcolm",
    from: "Malcolm",
    hints: { isFromKeyPerson: true },
  },
  {
    source: "slack",
    title: "DM from Ed Baum",
    body: "quick one — ok if I move the AG product review from Thursday to Tuesday? Isaac has a conflict",
    from: "Ed Baum",
    channel: "DM: Ed Baum",
    hints: { isDM: true, isFromKeyPerson: true },
  },
  {
    source: "slack",
    title: "Group DM: Malcolm + Ed",
    body: "michael, both of us free tomorrow 2pm if you want to sync on the TalentGenius naming decision",
    from: "Malcolm",
    channel: "Group DM: Malcolm, Ed",
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
    body: "@here heads up — legal flagged the AP marketplace contract. need to review before we sign with Olivia's team.",
    from: "Sam Jordan",
    channel: "#exec",
    hints: { isMention: true },
  },
  {
    source: "calendar",
    title: "Product Review moved to Tuesday 3pm",
    body: "Isaac moved the AG Product Review. Two hours earlier than originally scheduled.",
    from: "Isaac",
  },
  {
    source: "drive",
    title: "Olivia edited 'TG GTM Plan v3'",
    body: "Added new competitive landscape section and a revised rollout timeline. No questions posted — clean edit.",
    from: "Olivia",
  },
  {
    source: "slack",
    title: "#ag-launch",
    body: "Action item for Michael: confirm pricing tier names by EOD Wednesday. Owner: Michael. Due: 2026-04-16",
    from: "Crystal",
    channel: "#ag-launch",
  },
];

/**
 * POST /api/events/seed — reset the event store to the canonical demo set.
 * Useful on a fresh checkout or when iterating on rules. Not wired to the UI.
 */
export async function POST() {
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
  await replaceAll(events);
  return NextResponse.json({ seeded: events.length, events });
}
