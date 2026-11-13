import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { emitAuditEvent } from "@/lib/events/audit";
import { forwardEvent, CalendarNotConnectedError } from "@/lib/calendar/writes";

/**
 * POST /api/calendar/[eventId]/forward
 *
 * Forwards a calendar invite to more people. A Google event gets them added as
 * attendees (Google emails the invite); an Outlook event ("ms:" id) is
 * forwarded through Microsoft Graph, which sends the invite and tells the
 * organiser. Routed by lib/calendar/writes.ts.
 *
 * Body: { emails: string[] }
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ eventId: string }> }
) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { eventId } = await params;
  if (!eventId) return NextResponse.json({ error: "Missing eventId" }, { status: 400 });

  let emails: string[];
  try {
    const body = await req.json();
    emails = (body.emails || []).map((e: unknown) => String(e).trim()).filter(Boolean);
    if (emails.length === 0) return NextResponse.json({ error: "At least one email is required" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const { summary, added } = await forwardEvent(username, eventId, emails);
    if (added.length === 0) {
      return NextResponse.json({ success: true, message: "All recipients are already attendees" });
    }

    await emitAuditEvent({
      username,
      source: "calendar",
      headline: `Forwarded "${summary}" to ${added.join(", ")}`,
      context: `Event: ${summary}\nForwarded to: ${emails.join(", ")}`,
      rationale: "User forwarded a calendar invite to additional recipients.",
      tags: ["calendar", "forward"],
    });

    return NextResponse.json({ success: true, added: added.length });
  } catch (e) {
    if (e instanceof CalendarNotConnectedError) return NextResponse.json({ error: e.message }, { status: 401 });
    console.error("[calendar/forward] error:", e);
    return NextResponse.json({ error: "Failed to forward invite" }, { status: 500 });
  }
}
