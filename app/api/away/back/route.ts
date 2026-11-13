/**
 * POST /api/away/back — "I'm back early". Ends today any absence the user told
 * Basil about. An out-of-office block on Google Calendar has to be shortened
 * there; the response says so when one still covers today.
 */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { endDeclaredAway, getWorkCalendar } from "@/lib/away/store";
import { awayOn, dayIn } from "@/lib/away/calendar";

export const dynamic = "force-dynamic";

export async function POST() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const before = await getWorkCalendar(username, { refresh: "never" });
  const today = dayIn(Date.now(), before.timezone);
  const ended = await endDeclaredAway(username, today);
  const after = await getWorkCalendar(username, { refresh: "never" });
  const stillCovered = awayOn(today, after);
  return NextResponse.json({
    ok: true,
    ended,
    ...(stillCovered ? { stillAwayInCalendar: { label: stillCovered.label, end: stillCovered.end } } : {}),
  });
}
