/**
 * lib/pipedrive/collateral-server.ts — collateral suggestions and prompts for a
 * deal, from the stored Pipedrive copy (no Pipedrive or AI call).
 */
import "server-only";
import { getSettings } from "@/lib/settings/store";
import { dayIn } from "@/lib/away/calendar";
import { getPipedriveConfig, getStoredPipedriveSnapshot, type PipedriveSnapshot } from "@/lib/pipedrive/client";
import { readAutomation } from "@/lib/pipedrive/automation";
import { meetingNotes, resolveAccounts } from "@/lib/pipedrive/context";
import { suggestCollateral, type CollateralSuggestion } from "@/lib/pipedrive/collateral";

export interface DealCollateral {
  dealId: number;
  dealTitle: string;
  stage: string;
  organisation?: string;
  suggestions: CollateralSuggestion[];
}

function forDeal(snap: PipedriveSnapshot, dealId: number, today: string, sellerContext: string, sellerCompany?: string): DealCollateral | null {
  const deal = snap.deals.find((d) => d.id === dealId);
  if (!deal) return null;
  const org = deal.orgId !== null ? snap.orgs.find((o) => o.id === deal.orgId) : undefined;
  const people = snap.persons.filter((p) => p.id === deal.personId || (org && p.orgId === org.id));
  const pIds = new Set(people.map((p) => p.id));
  const touches = (x: { dealId: number | null; personId: number | null; orgId: number | null }) =>
    x.dealId === deal.id || (x.personId !== null && pIds.has(x.personId)) || (!!org && x.orgId === org.id);
  return {
    dealId: deal.id,
    dealTitle: deal.title,
    stage: deal.stage,
    ...(org ? { organisation: org.name } : {}),
    suggestions: suggestCollateral({
      deal, org, people,
      meetings: meetingNotes({ activities: snap.activities.filter(touches) }),
      notes: snap.notes.filter(touches).sort((a, b) => b.addTime.localeCompare(a.addTime)),
      planned: snap.activities.filter((a) => !a.done && touches(a)).sort((a, b) => (a.dueDate ?? "9").localeCompare(b.dueDate ?? "9")),
      today, sellerContext, sellerCompany,
    }),
  };
}

/**
 * Collateral for one deal (by id), or for the open deals of a person/company
 * (by name or email). Empty when Pipedrive has not been read yet.
 */
export async function collateralFor(username: string, q: { dealId?: number; query?: string }): Promise<{ deals: DealCollateral[]; readAt: number | null }> {
  const [snap, auto, settings, cfg] = await Promise.all([
    getStoredPipedriveSnapshot(username),
    readAutomation(username),
    getSettings(username).catch((e) => { console.warn("[collateral] settings unreadable:", e instanceof Error ? e.message : e); return null; }),
    getPipedriveConfig(username),
  ]);
  if (!snap) return { deals: [], readAt: null };
  const today = dayIn(Date.now(), settings?.timezone || "Europe/London");
  const company = cfg.companyName;
  let ids: number[] = [];
  if (q.dealId) ids = [q.dealId];
  else if (q.query?.trim()) {
    const term = q.query.trim().toLowerCase();
    const byTitle = snap.deals.filter((d) => d.status === "open" && d.title.toLowerCase().includes(term)).map((d) => d.id);
    const { persons, orgs } = resolveAccounts(snap, term.includes("@") ? { emails: [term] } : {
      names: [q.query.trim(), ...snap.orgs.filter((o) => o.name.toLowerCase().includes(term)).map((o) => o.name), ...snap.persons.filter((p) => p.name.toLowerCase().includes(term)).map((p) => p.name)].slice(0, 8),
    });
    const pIds = new Set(persons.map((p) => p.id));
    const oIds = new Set(orgs.map((o) => o.id));
    const byAccount = snap.deals.filter((d) => d.status === "open" && ((d.personId !== null && pIds.has(d.personId)) || (d.orgId !== null && oIds.has(d.orgId)))).map((d) => d.id);
    ids = [...new Set([...byTitle, ...byAccount])].slice(0, 3);
  }
  const deals = ids.map((id) => forDeal(snap, id, today, auto.sellerContext, company)).filter((x): x is DealCollateral => !!x);
  return { deals, readAt: snap.at };
}
