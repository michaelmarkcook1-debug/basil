/**
 * lib/pipedrive/followups.ts — suggested follow-ups from the CRM. Pure.
 *
 * Michael, 2026-11-24: "suggested follow ups, or automated follow up alerts
 * with opt in workflow automation for scheduling follow up meetings with prep".
 *
 * For the user's own open deals (and their own meetings), one suggestion per
 * deal, strongest reason first:
 *   after-meeting — a meeting or call of theirs finished in the last 10 days
 *                   and nothing is planned on that deal or contact since;
 *   past-close    — the expected close date has passed and it is still open;
 *   going-cold    — no update and no activity for `staleDays` (default 14);
 *   no-next-step  — open, with nothing planned.
 * Every suggestion names the contact to meet when Pipedrive has one, so the
 * scheduler can find a time with them.
 */

import type { PdActivity, PdDeal, PdOrg, PdPerson } from "@/lib/pipedrive/shape";
import { daysBetween, money } from "@/lib/pipedrive/shape";
import { timingFor, type Timing } from "@/lib/psychology/playbook";

export type FollowupKind = "after-meeting" | "past-close" | "going-cold" | "no-next-step";

export interface FollowupSuggestion {
  id: string;
  kind: FollowupKind;
  title: string;
  why: string;
  dealId: number | null;
  dealTitle?: string;
  value?: string;
  stage?: string;
  personId: number | null;
  contactName?: string;
  contactEmail?: string;
  orgName?: string;
  /** The date that set it off (meeting date, close date, last touch). */
  since: string;
  /** For ordering: higher first. */
  weight: number;
  /** When to send it and why (lib/psychology/playbook timingFor). */
  timing?: Timing;
}

export interface FollowupInput {
  userId: number | null;
  deals: PdDeal[];
  activities: PdActivity[];
  persons: PdPerson[];
  orgs: PdOrg[];
}

export interface FollowupOptions {
  today: string;
  staleDays?: number;
  /** id → ISO date it was dismissed; dismissed suggestions stay hidden for 14 days. */
  dismissed?: Record<string, string>;
}

const MEETING = /meeting|call|demo|lunch|presentation|workshop|zoom|teams/i;
const AFTER_MEETING_DAYS = 10;
const DISMISS_DAYS = 14;
const ORDER: Record<FollowupKind, number> = { "after-meeting": 4, "past-close": 3, "going-cold": 2, "no-next-step": 1 };

const day = (iso?: string | null) => (iso ? iso.slice(0, 10) : "");

export function suggestFollowups(s: FollowupInput, opts: FollowupOptions): FollowupSuggestion[] {
  const today = opts.today;
  const staleDays = opts.staleDays ?? 14;
  const me = s.userId;
  const mine = (ownerId?: number | null) => ownerId == null || ownerId === me;
  const person = new Map(s.persons.map((p) => [p.id, p]));
  const org = new Map(s.orgs.map((o) => [o.id, o]));
  const openDeals = s.deals.filter((d) => d.status === "open" && mine(d.ownerId));
  const dealById = new Map(s.deals.map((d) => [d.id, d]));

  const planned = s.activities.filter((a) => !a.done);
  const done = s.activities.filter((a) => a.done);
  const plannedOnDeal = new Set(planned.map((a) => a.dealId).filter((x): x is number => x !== null));
  const plannedWithPerson = new Set(planned.map((a) => a.personId).filter((x): x is number => x !== null));
  const lastDoneOnDeal = new Map<number, string>();
  for (const a of done) {
    if (a.dealId === null) continue;
    const at = day(a.doneTime) || day(a.updateTime);
    if (at > (lastDoneOnDeal.get(a.dealId) ?? "")) lastDoneOnDeal.set(a.dealId, at);
  }

  const contactOf = (personId: number | null, orgId: number | null) => {
    const p = personId !== null ? person.get(personId) : undefined;
    const o = orgId !== null ? org.get(orgId) : p?.orgId != null ? org.get(p.orgId) : undefined;
    return {
      personId: p?.id ?? null,
      ...(p ? { contactName: p.name } : {}),
      ...(p?.emails[0] ? { contactEmail: p.emails[0].toLowerCase() } : {}),
      ...(o ? { orgName: o.name } : {}),
    };
  };
  const dealBits = (d: PdDeal) => ({ dealId: d.id, dealTitle: d.title, value: money(d.value, d.currency), stage: d.stage });
  const who = (c: { contactName?: string; orgName?: string }) => [c.contactName, c.orgName].filter(Boolean).join(" at ") || "the client";

  const byKey = new Map<string, FollowupSuggestion>();
  const offer = (key: string, sug: FollowupSuggestion) => {
    const cur = byKey.get(key);
    if (!cur || ORDER[sug.kind] > ORDER[cur.kind]) byKey.set(key, sug);
  };

  // after-meeting: your meetings in the last 10 days with nothing planned since.
  for (const a of done) {
    if (!mine(a.ownerId) || !MEETING.test(`${a.type} ${a.subject}`)) continue;
    const at = day(a.doneTime) || day(a.dueDate) || day(a.updateTime);
    if (!at || at > today) continue;
    const ago = daysBetween(at, today);
    if (ago > AFTER_MEETING_DAYS) continue;
    const deal = a.dealId !== null ? dealById.get(a.dealId) : undefined;
    if (deal && deal.status !== "open") continue;
    if (deal ? plannedOnDeal.has(deal.id) : a.personId !== null && plannedWithPerson.has(a.personId)) continue;
    if (deal && (lastDoneOnDeal.get(deal.id) ?? "") > at) continue;
    if (!deal && a.personId === null) continue;
    const c = contactOf(a.personId ?? deal?.personId ?? null, a.orgId ?? deal?.orgId ?? null);
    const key = deal ? `deal:${deal.id}` : `person:${a.personId}`;
    offer(key, {
      id: `after-meeting:${deal ? `d${deal.id}` : `p${a.personId}`}:${at}`,
      kind: "after-meeting",
      title: `Follow up with ${who(c)}${deal ? ` on "${deal.title}"` : ""}`,
      why: `Your ${a.type} "${a.subject}" was ${ago === 0 ? "today" : `${ago} day${ago === 1 ? "" : "s"} ago`} and nothing is planned since.`,
      ...(deal ? dealBits(deal) : { dealId: null }),
      ...c,
      since: at,
      weight: 100 + (AFTER_MEETING_DAYS - ago) + (deal ? Math.log10(1 + deal.value) : 0),
    });
  }

  for (const d of openDeals) {
    const c = contactOf(d.personId, d.orgId);
    const key = `deal:${d.id}`;
    const hasPlan = plannedOnDeal.has(d.id);
    const lastTouch = [day(d.updateTime), lastDoneOnDeal.get(d.id) ?? ""].sort().pop()!;
    const quiet = lastTouch ? daysBetween(lastTouch, today) : 0;
    const v = Math.log10(1 + d.value);
    if (d.expectedClose && d.expectedClose < today) {
      const late = daysBetween(d.expectedClose, today);
      offer(key, {
        id: `past-close:d${d.id}:${d.expectedClose}`, kind: "past-close",
        title: `"${d.title}" is past its expected close date`,
        why: `Expected to close ${d.expectedClose} (${late} day${late === 1 ? "" : "s"} ago); still open in ${d.stage}${hasPlan ? "" : " with nothing planned"}.`,
        ...dealBits(d), ...c, since: d.expectedClose, weight: 80 + Math.min(late, 30) / 3 + v,
      });
    }
    if (!hasPlan && quiet >= staleDays) {
      offer(key, {
        id: `going-cold:d${d.id}:${lastTouch}`, kind: "going-cold",
        title: `"${d.title}" has gone quiet`,
        why: `No update or activity for ${quiet} days (last ${lastTouch}), and nothing is planned. ${d.stage}, ${money(d.value, d.currency)}.`,
        ...dealBits(d), ...c, since: lastTouch, weight: 60 + Math.min(quiet, 60) / 4 + v,
      });
    }
    if (!hasPlan) {
      offer(key, {
        id: `no-next-step:d${d.id}`, kind: "no-next-step",
        title: `Plan the next step on "${d.title}"`,
        why: `Open in ${d.stage} (${money(d.value, d.currency)}) with no activity planned.`,
        ...dealBits(d), ...c, since: lastTouch || today, weight: 40 + v,
      });
    }
  }

  const dismissed = opts.dismissed ?? {};
  return [...byKey.values()]
    .filter((x) => !dismissed[x.id] || daysBetween(dismissed[x.id].slice(0, 10), today) > DISMISS_DAYS)
    .sort((a, b) => b.weight - a.weight)
    .map((x) => ({ ...x, timing: timingFor({ situation: x.kind, today, daysSinceTouch: daysBetween(x.since, today) }) }));
}

/** The agenda Basil puts in a follow-up invite: what it is about, from the CRM. */
export function inviteAgenda(sug: FollowupSuggestion, appName = "Basil"): string {
  return [
    sug.dealTitle ? `Re: ${sug.dealTitle}${sug.stage ? ` (${sug.stage})` : ""}` : "",
    sug.why,
    "",
    `Scheduled from Pipedrive follow-ups by ${appName}.`,
  ].filter((l, i) => l || i > 1).join("\n");
}
