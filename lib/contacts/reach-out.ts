/**
 * lib/contacts/reach-out.ts — gathers the relationship signals for the weekly
 * "reach out to" push (rules in lib/contacts/reach-out-shape.ts). The same
 * delta engine and inputs as Today's cards: contacts, keep-in-touch rules,
 * tone history, days off not counted. No AI.
 */
import "server-only";
import { computeDeltas } from "@/lib/delta/compute";
import { listUserContacts } from "@/lib/contacts/user-store";
import { getAllOverridesFromStore } from "@/lib/contacts/overrides-store";
import { listMemories } from "@/lib/memory/store";
import { extractCadenceRules } from "@/lib/contacts/cadence-rules";
import { getWorkCalendar } from "@/lib/away/store";
import { dayIn, pausedDays } from "@/lib/away/calendar";
import type { ToneObservation } from "@/lib/contact-profile-overrides";
import { reachOutList, type ReachOut } from "@/lib/contacts/reach-out-shape";

export async function weeklyReachOut(username: string, timezone: string): Promise<ReachOut[]> {
  const [contacts, overrides, memories, workCal] = await Promise.all([
    listUserContacts(username),
    getAllOverridesFromStore(username),
    listMemories(username),
    getWorkCalendar(username, { refresh: "never" }).catch((e) => {
      console.warn("[reach-out] working calendar unreadable, counting every day:", e instanceof Error ? e.message : e);
      return null;
    }),
  ]);
  const toneHistory = new Map<string, ToneObservation[]>();
  for (const [cid, ov] of Object.entries(overrides)) if (ov?.toneHistory?.length) toneHistory.set(cid, ov.toneHistory);
  const now = Date.now();
  const todayDay = workCal ? dayIn(now, workCal.timezone) : null;
  const awayDaysSince = workCal && todayDay
    ? (iso: string) => { const t = Date.parse(iso); return Number.isFinite(t) ? pausedDays(dayIn(t, workCal.timezone), todayDay, workCal) : 0; }
    : undefined;
  const delta = computeDeltas({
    actions: [], decisions: [], contacts, since: new Date(now - 7 * 86_400_000), toneHistory,
    timezone, cadenceRules: extractCadenceRules(memories, contacts), awayDaysSince,
  });
  return reachOutList(delta.changes);
}
