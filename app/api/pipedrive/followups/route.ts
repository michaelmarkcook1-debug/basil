/**
 * /api/pipedrive/followups — suggested follow-ups from Pipedrive and the
 * user's opt-in for them (lib/pipedrive/automation).
 *
 * GET                                        → { mode, staleDays, meetingMinutes, readAt, stale, suggestions }
 * PATCH { mode?, staleDays?, meetingMinutes?, sellerContext? } → change the opt-in / selling context
 * POST  { action: "dismiss", id }             → hide one for 14 days
 * POST  { action: "refresh" }                 → read Pipedrive again now
 */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { followupState, dismissFollowup } from "@/lib/pipedrive/followups-server";
import { updateAutomation, FOLLOWUP_MODES, type FollowupMode } from "@/lib/pipedrive/automation";
import { refreshPipedriveSnapshot, isPipedriveConnected } from "@/lib/pipedrive/client";

export const maxDuration = 300;

async function view(username: string) {
  const st = await followupState(username, { storedOnly: true });
  return {
    connected: await isPipedriveConnected(username),
    mode: st.automation.mode,
    staleDays: st.automation.staleDays,
    meetingMinutes: st.automation.meetingMinutes,
    sellerContext: st.automation.sellerContext,
    readAt: st.snapshot?.at ?? null,
    stale: !!st.snapshot?.stale,
    counts: st.snapshot ? {
      deals: st.snapshot.deals.length,
      openDeals: st.snapshot.deals.filter((d) => d.status === "open").length,
      people: st.snapshot.persons.length,
      organisations: st.snapshot.orgs.length,
      notes: st.snapshot.notes.length,
      activities: st.snapshot.activities.length,
      meetingNotes: st.snapshot.activities.filter((a) => a.done && !!a.note?.trim()).length,
      incomplete: Object.entries(st.snapshot.coverage ?? {}).filter(([, v]) => !v.complete).map(([k]) => k),
      leads: st.snapshot.leads.length,
    } : null,
    suggestions: st.suggestions,
  };
}

export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  return NextResponse.json(await view(username));
}

export async function PATCH(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { mode?: unknown; staleDays?: unknown; meetingMinutes?: unknown; sellerContext?: unknown } | null; // ci-ok: bad body → 400 below
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  if (body.mode !== undefined && !FOLLOWUP_MODES.includes(body.mode as FollowupMode)) return NextResponse.json({ error: "unknown mode" }, { status: 400 });
  await updateAutomation(username, () => ({
    ...(body.mode !== undefined ? { mode: body.mode as FollowupMode } : {}),
    ...(typeof body.staleDays === "number" ? { staleDays: body.staleDays } : {}),
    ...(typeof body.meetingMinutes === "number" ? { meetingMinutes: body.meetingMinutes } : {}),
    ...(typeof body.sellerContext === "string" ? { sellerContext: body.sellerContext.slice(0, 4_000) } : {}),
  }));
  console.log(`[pipedrive/followups] ${username} set ${Object.keys(body).join(", ")}`);
  return NextResponse.json(await view(username));
}

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { action?: unknown; id?: unknown } | null; // ci-ok: bad body → 400 below
  if (body?.action === "dismiss" && typeof body.id === "string" && body.id.length < 200) {
    await dismissFollowup(username, body.id);
    return NextResponse.json(await view(username));
  }
  if (body?.action === "refresh") {
    try {
      await refreshPipedriveSnapshot(username);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
    }
    return NextResponse.json(await view(username));
  }
  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
