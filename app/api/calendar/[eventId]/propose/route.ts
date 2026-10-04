/**
 * POST /api/calendar/[eventId]/propose — propose a new time for an invitation.
 * Body: { start: ISO, end: ISO, note?: string, response?: "tentative"|"declined", emailOrganizer?: boolean }
 *
 * Google's API has no "propose a new time" endpoint, so this answers Maybe (or
 * No) with the proposal in the note the organiser sees, and emails the
 * organiser the proposal (lib/google/calendar.ts proposeNewTime).
 */
import { NextResponse } from "next/server";
import { isGoogleConnected } from "@/lib/google/auth";
import { getSessionUser } from "@/lib/auth";
import { proposeNewTime, NotAnAttendeeError } from "@/lib/google/calendar";
import { getSettings } from "@/lib/settings/store";
import { resolveTimezone } from "@/lib/timezone";
import { emitAuditEvent } from "@/lib/events/audit";
import { checkRateLimitDurable } from "@/lib/rate-limit";

export async function POST(req: Request, { params }: { params: Promise<{ eventId: string }> }) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  if (!(await isGoogleConnected(username))) {
    return NextResponse.json({ error: "Google Calendar not connected." }, { status: 401 });
  }
  const rl = await checkRateLimitDurable(`calendar:propose:${username}`, 10);
  if (!rl.allowed) return NextResponse.json({ error: "Too many proposals — try again shortly." }, { status: 429 });
  const { eventId } = await params;
  if (!eventId) return NextResponse.json({ error: "Missing eventId" }, { status: 400 });

  let body: { start?: unknown; end?: unknown; note?: unknown; response?: unknown; emailOrganizer?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  if (typeof body.start !== "string" || typeof body.end !== "string") {
    return NextResponse.json({ error: "start and end are required" }, { status: 400 });
  }
  const response = body.response === "declined" ? "declined" : "tentative";

  try {
    const settings = await getSettings(username);
    const out = await proposeNewTime(username, eventId, {
      start: body.start,
      end: body.end,
      note: typeof body.note === "string" ? body.note : undefined,
      response,
      emailOrganizer: body.emailOrganizer !== false,
      senderName: settings.name,
      timeZone: resolveTimezone(settings, req),
    });
    await emitAuditEvent({
      username,
      source: "calendar",
      headline: `Proposed a new time${out.emailedTo ? ` to ${out.emailedTo}` : ""}`,
      context: out.comment,
      rationale: `Proposed a new time from Basil (${response === "declined" ? "declined" : "maybe"} on the invite).`,
      tags: ["calendar", "rsvp", "propose"],
    });
    return NextResponse.json({ success: true, status: response, emailedTo: out.emailedTo ?? null });
  } catch (e) {
    if (e instanceof NotAnAttendeeError) return NextResponse.json({ error: e.message }, { status: 409 });
    if (e instanceof RangeError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error("[calendar/propose] failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Could not send the proposal." }, { status: 502 });
  }
}
