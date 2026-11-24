/**
 * lib/pipedrive/context.ts — Pipedrive as text for Basil's prompts. Pure: it
 * takes a snapshot and returns blocks, so every surface (briefing, meeting
 * prep, Ask Basil, contact profiles) words the CRM the same way.
 *
 *   - briefingBlock: what moved in the pipeline and what is due.
 *   - accountBlock:  everything Pipedrive knows about named people or
 *                    companies — deals in every status, notes, activities.
 *   - mentionedIn:   which Pipedrive people / companies a piece of text names,
 *                    so Ask Basil gets their CRM record without being asked.
 */

import type { PdActivity, PdDeal, PdLead, PdNote, PdOrg, PdPerson } from "@/lib/pipedrive/shape";
import { daysBetween, dueActivities, emailDomain, money } from "@/lib/pipedrive/shape";

/** The parts of a snapshot these renderers read. */
export interface CrmData {
  userId: number | null;
  activities: PdActivity[];
  deals: PdDeal[];
  persons: PdPerson[];
  orgs: PdOrg[];
  notes: PdNote[];
  leads: PdLead[];
  users: Record<string, string>;
  stale?: boolean;
  at: number;
}

const day = (iso?: string | null) => (iso ? iso.slice(0, 10) : "");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function indexes(s: CrmData) {
  return {
    person: new Map(s.persons.map((p) => [p.id, p])),
    org: new Map(s.orgs.map((o) => [o.id, o])),
    deal: new Map(s.deals.map((d) => [d.id, d])),
    owner: (id?: number | null) => (id ? s.users[String(id)] : undefined),
  };
}

function dealLine(d: PdDeal, ix: ReturnType<typeof indexes>, me: number | null): string {
  const who = [d.personId ? ix.person.get(d.personId)?.name : "", d.orgId ? ix.org.get(d.orgId)?.name : ""].filter(Boolean).join(", ");
  const owner = d.ownerId && d.ownerId !== me ? ` · owner ${ix.owner(d.ownerId) ?? d.ownerId}` : "";
  const status =
    d.status === "won" ? `WON ${day(d.wonTime)}`
    : d.status === "lost" ? `LOST ${day(d.lostTime)}${d.lostReason ? ` (${clip(d.lostReason, 80)})` : ""}`
    : `${d.pipeline ? `${d.pipeline} › ` : ""}${d.stage}${d.expectedClose ? ` · expected close ${d.expectedClose}` : ""}`;
  return `- "${d.title}" — ${money(d.value, d.currency)} · ${status}${who ? ` · ${who}` : ""}${owner} · updated ${day(d.updateTime)}`;
}

function activityLine(a: PdActivity, ix: ReturnType<typeof indexes>, me: number | null, today: string): string {
  const when = a.done ? `done ${day(a.doneTime) || day(a.updateTime)}`
    : a.dueDate ? (a.dueDate < today ? `OVERDUE ${daysBetween(a.dueDate, today)}d (due ${a.dueDate})` : `due ${a.dueDate}${a.dueTime ? ` ${a.dueTime}` : ""}`)
    : "no date";
  const deal = a.dealId ? ix.deal.get(a.dealId)?.title : undefined;
  const who = [a.personId ? ix.person.get(a.personId)?.name : "", a.orgId ? ix.org.get(a.orgId)?.name : ""].filter(Boolean).join(", ");
  const owner = a.ownerId && a.ownerId !== me ? ` · ${ix.owner(a.ownerId) ?? "colleague"}'s` : "";
  return `- ${a.type}: "${a.subject}" — ${when}${deal ? ` · deal "${deal}"` : ""}${who ? ` · ${who}` : ""}${owner}${a.note ? ` · note: ${clip(a.note, 200)}` : ""}`;
}

function noteLine(n: PdNote, ix: ReturnType<typeof indexes>, max = 400): string {
  const on = [n.dealId ? `deal "${ix.deal.get(n.dealId)?.title ?? n.dealId}"` : "", n.personId ? ix.person.get(n.personId)?.name : "", n.orgId ? ix.org.get(n.orgId)?.name : ""].filter(Boolean).join(", ");
  return `- ${day(n.addTime)}${n.userId ? ` by ${ix.owner(n.userId) ?? "a colleague"}` : ""}${on ? ` on ${on}` : ""}: ${clip(n.content.replace(/\s+/g, " "), max)}`;
}

const header = (s: CrmData) => (s.stale ? `(Pipedrive could not be refreshed; this is the copy from ${new Date(s.at).toISOString().slice(0, 16).replace("T", " ")} UTC.)\n` : "");

/** The pipeline for the daily briefing: due work, what moved, what is closing, what is stuck. */
export function briefingBlock(s: CrmData, today: string, opts: { sinceDays?: number } = {}): string {
  const ix = indexes(s);
  const me = s.userId;
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - (opts.sinceDays ?? 7) * 86_400_000).toISOString();
  const mineOpen = s.activities.filter((a) => !a.done && (a.ownerId == null || a.ownerId === me));
  const { overdue, dueToday } = dueActivities(mineOpen, today);
  const open = s.deals.filter((d) => d.status === "open");
  const closing = open.filter((d) => d.expectedClose && d.expectedClose >= today && daysBetween(today, d.expectedClose) <= 14)
    .sort((a, b) => a.expectedClose!.localeCompare(b.expectedClose!));
  const pastClose = open.filter((d) => d.expectedClose && d.expectedClose < today);
  const moved = open.filter((d) => d.stageChangeTime && d.stageChangeTime >= since).sort((a, b) => b.stageChangeTime!.localeCompare(a.stageChangeTime!));
  const won = s.deals.filter((d) => d.status === "won" && d.wonTime && d.wonTime >= since);
  const lost = s.deals.filter((d) => d.status === "lost" && d.lostTime && d.lostTime >= since);
  const stuck = open.filter((d) => daysBetween(day(d.updateTime), today) >= 21 && (d.ownerId == null || d.ownerId === me))
    .sort((a, b) => a.updateTime.localeCompare(b.updateTime));
  const newLeads = s.leads.filter((l) => !l.archived && l.addTime >= since);
  const notes = s.notes.filter((n) => n.addTime >= since).slice(0, 12);
  const sec = (title: string, lines: string[], max: number) =>
    lines.length ? `${title} (${lines.length})\n${lines.slice(0, max).join("\n")}${lines.length > max ? `\n- …and ${lines.length - max} more` : ""}` : "";
  const totalOpen = open.reduce((m, d) => { m[d.currency] = (m[d.currency] ?? 0) + d.value; return m; }, {} as Record<string, number>);
  const body = [
    `Open pipeline: ${open.length} deals${Object.keys(totalOpen).length ? ` worth ${Object.entries(totalOpen).map(([c, v]) => money(v, c)).join(" + ")}` : ""}.`,
    sec("Your OVERDUE sales activities", overdue.map((a) => activityLine(a, ix, me, today)), 12),
    sec("Your sales activities DUE TODAY", dueToday.map((a) => activityLine(a, ix, me, today)), 12),
    sec("Deals expected to close in the next 14 days", closing.map((d) => dealLine(d, ix, me)), 10),
    sec("Open deals PAST their expected close date", pastClose.map((d) => dealLine(d, ix, me)), 8),
    sec(`Deals that changed stage in the last ${opts.sinceDays ?? 7} days`, moved.map((d) => dealLine(d, ix, me)), 10),
    sec("Won recently", won.map((d) => dealLine(d, ix, me)), 8),
    sec("Lost recently", lost.map((d) => dealLine(d, ix, me)), 8),
    sec("Your open deals with no update in 21+ days (going cold)", stuck.map((d) => dealLine(d, ix, me)), 8),
    sec("New leads", newLeads.map((l) => `- "${l.title}"${l.orgId ? ` · ${ix.org.get(l.orgId)?.name ?? ""}` : ""}${l.personId ? ` · ${ix.person.get(l.personId)?.name ?? ""}` : ""}${l.source ? ` · from ${l.source}` : ""} · added ${day(l.addTime)}`), 8),
    sec("Recent CRM notes", notes.map((n) => noteLine(n, ix, 300)), 12),
  ].filter(Boolean);
  return header(s) + body.join("\n\n");
}

export interface AccountQuery { emails?: readonly string[]; names?: readonly string[]; personIds?: readonly number[]; orgIds?: readonly number[] }

/** Which people and organisations a query points at. Names match whole, case-insensitively. */
export function resolveAccounts(s: CrmData, q: AccountQuery): { persons: PdPerson[]; orgs: PdOrg[] } {
  const emails = new Set((q.emails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean));
  const names = new Set((q.names ?? []).map((n) => n.trim().toLowerCase()).filter((n) => n.length >= 3));
  const persons = s.persons.filter((p) =>
    (q.personIds ?? []).includes(p.id) || p.emails.some((e) => emails.has(e.toLowerCase())) || names.has(p.name.trim().toLowerCase()));
  const domains = new Set([...emails].map((e) => emailDomain(e)).filter((d): d is string => !!d));
  const orgIds = new Set([...(q.orgIds ?? []), ...persons.map((p) => p.orgId).filter((x): x is number => x !== null)]);
  const orgs = s.orgs.filter((o) => orgIds.has(o.id) || names.has(o.name.trim().toLowerCase()) || (!!o.domain && domains.has(o.domain)));
  return { persons, orgs };
}

/** Everything Pipedrive holds on these people / companies. Empty string when it knows none of them. */
export function accountBlock(s: CrmData, q: AccountQuery, today: string, opts: { maxNotes?: number; maxActivities?: number } = {}): string {
  const { persons, orgs } = resolveAccounts(s, q);
  if (persons.length === 0 && orgs.length === 0) return "";
  const ix = indexes(s);
  const me = s.userId;
  const pIds = new Set(persons.map((p) => p.id));
  const oIds = new Set(orgs.map((o) => o.id));
  const touches = (x: { personId: number | null; orgId: number | null }) => (x.personId !== null && pIds.has(x.personId)) || (x.orgId !== null && oIds.has(x.orgId));
  const deals = s.deals.filter(touches).sort((a, b) => (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1) || b.updateTime.localeCompare(a.updateTime));
  const dIds = new Set(deals.map((d) => d.id));
  const acts = s.activities.filter((a) => touches(a) || (a.dealId !== null && dIds.has(a.dealId)));
  const openActs = acts.filter((a) => !a.done).sort((a, b) => (a.dueDate ?? "9").localeCompare(b.dueDate ?? "9"));
  const doneActs = acts.filter((a) => a.done).sort((a, b) => (b.doneTime ?? b.updateTime).localeCompare(a.doneTime ?? a.updateTime));
  const notes = s.notes.filter((n) => touches(n) || (n.dealId !== null && dIds.has(n.dealId))).sort((a, b) => b.addTime.localeCompare(a.addTime));
  const leads = s.leads.filter((l) => !l.archived && touches(l));
  const lines: string[] = [];
  for (const p of persons) {
    const org = p.orgId ? ix.org.get(p.orgId) : undefined;
    lines.push(`Person: ${p.name}${p.jobTitle ? `, ${p.jobTitle}` : ""}${org ? ` at ${org.name}` : ""}${p.emails.length ? ` · ${p.emails.join(", ")}` : ""}`);
  }
  for (const o of orgs) lines.push(`Organisation: ${o.name}${o.industry ? ` (${o.industry})` : ""}${o.website ? ` · ${o.website}` : ""}`);
  if (deals.length) lines.push(`Deals (${deals.length}):\n${deals.slice(0, 15).map((d) => dealLine(d, ix, me)).join("\n")}`);
  if (leads.length) lines.push(`Open leads:\n${leads.slice(0, 5).map((l) => `- "${l.title}" · added ${day(l.addTime)}`).join("\n")}`);
  if (openActs.length) lines.push(`Planned activities:\n${openActs.slice(0, opts.maxActivities ?? 8).map((a) => activityLine(a, ix, me, today)).join("\n")}`);
  if (doneActs.length) lines.push(`Recent completed activities:\n${doneActs.slice(0, opts.maxActivities ?? 8).map((a) => activityLine(a, ix, me, today)).join("\n")}`);
  if (notes.length) lines.push(`Notes (newest first):\n${notes.slice(0, opts.maxNotes ?? 8).map((n) => noteLine(n, ix)).join("\n")}`);
  return header(s) + lines.join("\n");
}

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The Pipedrive people and companies a message names: full person names and
 * organisation names of 4+ characters, as whole words. Capped, so a message
 * listing twenty companies does not pull twenty CRM records into the prompt.
 */
export function mentionedIn(s: CrmData, text: string, max = 4): AccountQuery {
  const t = text.toLowerCase();
  if (t.trim().length < 3) return {};
  const hit = (name: string) => name.length >= 4 && new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(name.toLowerCase())}($|[^\\p{L}\\p{N}])`, "u").test(t);
  const orgIds = s.orgs.filter((o) => hit(o.name.trim())).slice(0, max).map((o) => o.id);
  const personIds = s.persons.filter((p) => p.name.trim().includes(" ") && hit(p.name.trim())).slice(0, max).map((p) => p.id);
  const emails = (t.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? []).slice(0, max);
  return { orgIds, personIds, emails };
}

/**
 * Pipedrive as evidence for a contact profile: their deals, notes about them
 * and their company, and meetings/calls with them. Always "said by others" —
 * CRM records describe the account, never how the person communicates.
 */
export function profileEvidence(s: CrmData, q: AccountQuery, max = 12): Array<{ channel: "crm"; by: "others"; date?: string; title: string; text: string }> {
  const { persons, orgs } = resolveAccounts(s, q);
  if (persons.length === 0 && orgs.length === 0) return [];
  const ix = indexes(s);
  const pIds = new Set(persons.map((p) => p.id));
  const oIds = new Set(orgs.map((o) => o.id));
  const touches = (x: { personId: number | null; orgId: number | null }) => (x.personId !== null && pIds.has(x.personId)) || (x.orgId !== null && oIds.has(x.orgId));
  const deals = s.deals.filter(touches);
  const dIds = new Set(deals.map((d) => d.id));
  const out: Array<{ channel: "crm"; by: "others"; date?: string; title: string; text: string }> = [];
  for (const d of deals.slice(0, 5)) {
    out.push({ channel: "crm", by: "others", date: day(d.updateTime), title: `Deal · ${clip(d.title, 40)}`, text: `Pipedrive deal ${dealLine(d, ix, s.userId).slice(2)}` });
  }
  for (const n of s.notes.filter((n) => touches(n) || (n.dealId !== null && dIds.has(n.dealId))).slice(0, 5)) {
    out.push({ channel: "crm", by: "others", date: day(n.addTime), title: "Note", text: `Pipedrive note${n.userId ? ` by ${ix.owner(n.userId) ?? "a colleague"}` : ""}: ${clip(n.content.replace(/\s+/g, " "), 600)}` });
  }
  for (const a of s.activities.filter((a) => a.done && (touches(a) || (a.dealId !== null && dIds.has(a.dealId))) && MEETINGISH.test(`${a.type} ${a.subject}`)).slice(0, 4)) {
    out.push({ channel: "crm", by: "others", date: day(a.doneTime) || day(a.updateTime), title: a.type, text: `Pipedrive ${a.type} "${a.subject}"${a.note ? ` — ${clip(a.note, 400)}` : ""}` });
  }
  return out.slice(0, max);
}

const MEETINGISH = /meeting|call|demo|lunch|presentation|workshop/i;
