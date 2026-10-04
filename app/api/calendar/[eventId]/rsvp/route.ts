/**
 * POST /api/calendar/[eventId]/rsvp — accept, decline or "maybe" an invitation.
 * Body: { status: "accepted" | "declined" | "tentative", comment?: string }
 *
 * The organiser is notified (sendUpdates:"all"). 409 when the user is not on
 * the guest list — this used to change nothing and still answer success.
 */
import { NextResponse } from "next/server";
import { isGoogleConnected } from "@/lib/google/auth";
import { getSessionUser } from "@/lib/auth";
import { respondToEvent, NotAnAttendeeError, type RsvpResponse } from "@/lib/google/calendar";
import { emitAuditEvent } from "@/lib/events/audit";

const LABEL: Record<RsvpResponse, string> = { accepted: "Accepted", declined: "Declined", tentative: "Maybe" };

export async function POST(req: Request, { params }: { params: Promise<{ eventId: string }> }) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  if (!(await isGoogleConnected(username))) {
    return NextResponse.json({ error: "Google Calendar not connected." }, { status: 401 });
  }
  const { eventId } = await params;
  if (!eventId) return NextResponse.json({ error: "Missing eventId" }, { status: 400 });

  let status: RsvpResponse, comment: string | undefined;
  try {
    const body = await req.json() as { status?: string; comment?: unknown };
    if (body.status !== "accepted" && body.status !== "declined" && body.status !== "tentative") {
      return NextResponse.json({ error: "status must be accepted, declined, or tentative" }, { status: 400 });
    }
    status = body.status;
    comment = typeof body.comment === "string" && body.comment.trim() ? body.comment : undefined;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const ev = await respondToEvent(username, eventId, { response: status, comment });
    await emitAuditEvent({
      username,
      source: "calendar",
      headline: `${LABEL[status]} "${ev.summary}"`,
      context: `Event: ${ev.summary}\nDate: ${ev.start}${comment ? `\nNote: ${comment}` : ""}`,
      rationale: `Responded ${status} to the invitation in Basil; the organiser was notified.`,
      tags: ["calendar", "rsvp", status],
    });
    return NextResponse.json({ success: true, status });
  } catch (e) {
    if (e instanceof NotAnAttendeeError) return NextResponse.json({ error: e.message }, { status: 409 });
    console.error("[calendar/rsvp] failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Could not send your response to Google Calendar." }, { status: 502 });
  }
}
