/**
 * POST /api/away/redate  { newDate? }
 *
 * The first day back: move the user's own commitments that fell due during
 * the absence to one new date (default: the third working day from today), so
 * they come back to a list with dates rather than a wall of "overdue".
 */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getWorkCalendar } from "@/lib/away/store";
import { addDays, awayStatus, dayIn, isIsoDay } from "@/lib/away/calendar";
import { fellDueWhileAway, suggestedRedateDay } from "@/lib/away/fell-due";
import { listActions, bulkUpdateActions } from "@/lib/actions/store";
import { getSelfIdentity } from "@/lib/self-identity";

export const dynamic = "force-dynamic";

/** How long after coming back the offer stands. */
const OFFER_DAYS = 14;

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const body = await req.json().catch(() => ({})) as { newDate?: unknown };

  const cal = await getWorkCalendar(username, { refresh: "never" });
  const today = dayIn(Date.now(), cal.timezone);
  if (awayStatus(today, cal).state === "away") {
    return NextResponse.json({ error: "You are still away today." }, { status: 409 });
  }
  const period = cal.away
    .filter((p) => p.end < today && p.end >= addDays(today, -OFFER_DAYS))
    .sort((a, b) => (a.end < b.end ? 1 : -1))[0];
  if (!period) return NextResponse.json({ error: "No recent absence to re-date from." }, { status: 404 });

  const newDate = body.newDate === undefined ? suggestedRedateDay(today, cal) : body.newDate;
  if (!isIsoDay(newDate) || newDate < today) {
    return NextResponse.json({ error: "Pick a date from today onwards (YYYY-MM-DD)." }, { status: 400 });
  }

  const [actions, identity] = await Promise.all([
    listActions(username, { fresh: true }),
    getSelfIdentity(username).catch(() => ({ emails: [] as string[], names: [] as string[] })),
  ]);
  const due = fellDueWhileAway(actions, period, today, identity.names);
  const moved = await bulkUpdateActions(username, due.map((a) => ({ id: a.id, patch: { dueDate: newDate, status: "open" as const } })));
  return NextResponse.json({ ok: true, moved, newDate, from: period.start, to: period.end });
}
