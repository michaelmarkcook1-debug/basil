import { NextResponse } from "next/server";
import { isGoogleConnected } from "@/lib/google/auth";
import { getRecentEmails } from "@/lib/google/gmail";
import { getSessionUser } from "@/lib/auth";
import { listEvents } from "@/lib/events/store";

export async function GET() {
  const username = (await getSessionUser());
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  if (!(await isGoogleConnected(username))) {
    return NextResponse.json({
      connected: false,
      emails: [],
      message: "Gmail not connected. Set up OAuth in Settings.",
    });
  }

  try {
    const [emails, events] = await Promise.all([
      getRecentEmails(username, 8),
      listEvents(),
    ]);

    // Build a map from externalId → event for quick lookup
    const eventByRef = new Map<string, { analysed: boolean; materialized: boolean }>();
    for (const ev of events) {
      const ref = ev.sourceRef ?? ev.externalId;
      if (!ref) continue;
      // An event is "materialized" if it has linked actions/decisions, or was auto-executed
      const materialized = !!(ev.actionId || ev.decisionId || ev.memoryId ||
        ev.status === "executed" || ev.status === "approved");
      eventByRef.set(ref, { analysed: true, materialized });
    }

    const enriched = emails.map((e) => {
      const ref = `gmail:${e.id}`;
      const ev = eventByRef.get(ref);
      return {
        ...e,
        // undefined = not yet ingested, false = ingested but nothing extracted, true = something created
        analysed: ev?.analysed ?? false,
        materialized: ev?.materialized ?? false,
      };
    });

    return NextResponse.json({
      connected: true,
      emails: enriched,
      message: emails.length === 0 ? "No recent emails." : `${emails.length} recent emails.`,
    });
  } catch (e) {
    console.error("Gmail API error:", e);
    return NextResponse.json({
      connected: false,
      emails: [],
      message: "Gmail error — please try again",
    });
  }
}
