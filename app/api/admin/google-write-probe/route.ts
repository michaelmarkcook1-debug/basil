export const maxDuration = 60;

import { NextResponse } from "next/server";
import { google } from "googleapis";
import { getAuthedClient, getGrantedScopes, GOOGLE_SCOPE } from "@/lib/google/auth";
import { getSessionUser } from "@/lib/auth";
import { isAdminUser } from "@/lib/users";

/**
 * GET /api/admin/google-write-probe?username=michael&write=1
 *
 * Answers one question that a read check CANNOT: are Google Calendar WRITES
 * actually working? `calendar.readonly` satisfies every events.list call in the
 * app while failing every events.insert with a 403, so "reads work" is not
 * evidence that scheduling works.
 *
 * Without `write=1` this only reports granted scopes — completely read-only.
 * With `write=1` it inserts a probe event and deletes it again:
 *   - no attendees, so Google emails no invitations to anyone
 *   - sendUpdates "none" belt-and-braces
 *   - deleted in a finally block, and the delete result is reported honestly
 *     so a leftover probe can never go unnoticed
 * The probe is 1 minute long, tomorrow, clearly labelled.
 */
export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  const isCronCall = !!cronSecret && authHeader === `Bearer ${cronSecret}`;

  const { searchParams } = new URL(req.url);
  let username: string;
  if (isCronCall) {
    const p = searchParams.get("username");
    if (!p) return NextResponse.json({ error: "username required" }, { status: 400 });
    username = p;
  } else {
    const s = await getSessionUser();
    if (!s) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    if (!isAdminUser(s)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    username = s;
  }

  const scopes = await getGrantedScopes(username);
  const hasCalendarWrite = scopes.includes(GOOGLE_SCOPE.calendar);
  const readonlyOnly = scopes.some((s) => s.endsWith("/auth/calendar.readonly")) && !hasCalendarWrite;

  const result: Record<string, unknown> = {
    username,
    scopes,
    hasCalendarWriteScope: hasCalendarWrite,
    readonlyOnly,
  };

  if (searchParams.get("write") !== "1") {
    result.note = "scope report only — pass write=1 to actually probe an insert";
    return NextResponse.json(result);
  }

  const auth = await getAuthedClient(username);
  if (!auth) {
    result.writeProbe = { ok: false, error: "no authed Google client (token missing/unrefreshable)" };
    return NextResponse.json(result, { status: 200 });
  }

  const calendar = google.calendar({ version: "v3", auth });
  const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10);
  let createdId: string | null = null;

  try {
    const ins = await calendar.events.insert({
      calendarId: "primary",
      sendUpdates: "none", // never notify anyone — this is a diagnostic
      requestBody: {
        summary: "[Basil diagnostic] write probe — safe to ignore",
        description: "Automated check that Basil can write to Google Calendar. Deleted immediately.",
        start: { dateTime: `${tomorrow}T03:00:00`, timeZone: "Europe/London" },
        end:   { dateTime: `${tomorrow}T03:01:00`, timeZone: "Europe/London" },
      },
    });
    createdId = ins.data.id ?? null;
    result.writeProbe = { ok: true, createdEventId: createdId, htmlLink: ins.data.htmlLink };
  } catch (e: unknown) {
    const err = e as { code?: number; message?: string; errors?: unknown };
    result.writeProbe = {
      ok: false,
      code: err?.code,
      message: err?.message?.slice(0, 400),
      details: err?.errors,
    };
  } finally {
    if (createdId) {
      try {
        await calendar.events.delete({ calendarId: "primary", eventId: createdId, sendUpdates: "none" });
        (result.writeProbe as Record<string, unknown>).cleanedUp = true;
      } catch (delErr) {
        // Surface loudly rather than leaving a mystery event on a real calendar.
        (result.writeProbe as Record<string, unknown>).cleanedUp = false;
        (result.writeProbe as Record<string, unknown>).cleanupError =
          delErr instanceof Error ? delErr.message.slice(0, 200) : String(delErr);
      }
    }
  }

  return NextResponse.json(result);
}
