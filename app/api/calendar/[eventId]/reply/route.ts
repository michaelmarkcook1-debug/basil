import { NextResponse } from "next/server";
import { isGoogleConnected, getAuthedClient } from "@/lib/google/auth";
import { getSessionUser } from "@/lib/auth";
import { google } from "googleapis";
import { emitAuditEvent } from "@/lib/events/audit";

/**
 * POST /api/calendar/[eventId]/reply
 *
 * Send an email reply to the event organiser (and optionally all attendees).
 * Body: { message: string; replyAll?: boolean }
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ eventId: string }> }
) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  if (!(await isGoogleConnected(username))) {
    return NextResponse.json({ error: "Google Calendar not connected." }, { status: 401 });
  }

  const { eventId } = await params;
  if (!eventId) return NextResponse.json({ error: "Missing eventId" }, { status: 400 });

  let message: string;
  let replyAll = false;
  try {
    const body = await req.json();
    message = (body.message || "").trim();
    replyAll = !!body.replyAll;
    if (!message) return NextResponse.json({ error: "message is required" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const auth = await getAuthedClient(username);
  if (!auth) return NextResponse.json({ error: "Google auth unavailable" }, { status: 500 });

  try {
    // Fetch event to get organiser + attendee list
    const calendar = google.calendar({ version: "v3", auth });
    const { data: ev } = await calendar.events.get({ calendarId: "primary", eventId });

    const organizerEmail: string | undefined = ev.organizer?.email ?? undefined;
    if (!organizerEmail) {
      return NextResponse.json({ error: "Cannot determine organiser email" }, { status: 422 });
    }

    // Build recipient list
    const recipients: string[] = [organizerEmail];
    if (replyAll) {
      const others = (ev.attendees || [])
        .filter((a) => !a.self && a.email && a.email !== organizerEmail)
        .map((a) => a.email as string);
      recipients.push(...others);
    }

    const subject = `Re: ${ev.summary || "Meeting"}`;
    const toHeader = recipients.join(", ");

    // Build and send raw MIME message via Gmail API
    const gmail = google.gmail({ version: "v1", auth });
    const raw = Buffer.from(
      `To: ${toHeader}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${message}`
    ).toString("base64url");

    await gmail.users.messages.send({ userId: "me", requestBody: { raw } });

    await emitAuditEvent({
      username,
      source: "calendar",
      headline: `Replied to "${ev.summary || eventId}" organiser`,
      context: `To: ${toHeader}\n\n${message.slice(0, 200)}`,
      rationale: `User replied to calendar event invite${replyAll ? " (reply all)" : ""}.`,
      tags: ["calendar", "reply"],
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("[calendar/reply] error:", e);
    return NextResponse.json({ error: "Failed to send reply" }, { status: 500 });
  }
}
