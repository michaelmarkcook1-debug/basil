/**
 * /api/away — time off.
 *
 *   GET     today's status, the absences Basil knows about (from Google Calendar
 *           and from what the user told Basil), and the working-days settings
 *   POST    { start, end, label?, cover? } — tell Basil about an absence
 *   DELETE  ?id=basil:… — remove one the user told Basil about (calendar
 *           blocks are removed in Google Calendar)
 */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { AwayInputError, declareAway, getTodayAway, getWorkCalendar, removeDeclaredAway } from "@/lib/away/store";
import { addDays, dayIn } from "@/lib/away/calendar";

export const dynamic = "force-dynamic";

export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const [cal, status] = await Promise.all([getWorkCalendar(username), getTodayAway(username)]);
  const today = dayIn(Date.now(), cal.timezone);
  return NextResponse.json({
    status,
    // Current and coming absences, plus any that ended in the last month.
    periods: cal.away.filter((p) => p.end >= addDays(today, -30)),
    workingDays: cal.workingDays,
    holidayRegion: cal.holidayRegion,
    timezone: cal.timezone,
  });
}

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const body = await req.json().catch(() => ({})) as { start?: unknown; end?: unknown; label?: unknown; cover?: unknown };
  try {
    const period = await declareAway(username, {
      start: String(body.start ?? ""),
      end: String(body.end ?? ""),
      label: typeof body.label === "string" ? body.label : undefined,
      cover: typeof body.cover === "string" ? body.cover : undefined,
    });
    return NextResponse.json({ ok: true, period });
  } catch (e) {
    if (e instanceof AwayInputError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

export async function DELETE(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id.startsWith("basil:")) {
    return NextResponse.json({ error: "Only absences you told Basil about can be removed here. Remove calendar blocks in Google Calendar." }, { status: 400 });
  }
  const removed = await removeDeclaredAway(username, id);
  return removed ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Not found" }, { status: 404 });
}
