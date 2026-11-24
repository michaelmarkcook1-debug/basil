/**
 * lib/pipedrive/shape.ts — the pure half of the Pipedrive integration: the
 * record shapes Basil keeps, which activities need you today, and the client
 * directory (people's emails and organisations' web domains) that files
 * client mail into Clients & Sales. No server-only imports, so it is testable.
 */

export interface PdActivity {
  id: number;
  subject: string;
  type: string;
  dueDate: string | null;   // YYYY-MM-DD
  dueTime: string | null;   // HH:MM
  dealId: number | null;
  personId: number | null;
  orgId: number | null;
  leadId?: string | null;
  note?: string;
  updateTime: string;
  ownerId?: number | null;
  done?: boolean;
  doneTime?: string | null;
}

export interface PdDeal {
  id: number;
  title: string;
  value: number;
  currency: string;
  stage: string;
  status: string;
  personId: number | null;
  orgId: number | null;
  expectedClose: string | null;
  updateTime: string;
  stageChangeTime: string | null;
  ownerId?: number | null;
  pipeline?: string;
  addTime?: string;
  wonTime?: string | null;
  lostTime?: string | null;
  lostReason?: string | null;
  probability?: number | null;
}

export interface PdPerson { id: number; name: string; emails: string[]; orgId: number | null; jobTitle?: string; phones?: string[] }
export interface PdOrg { id: number; name: string; website?: string; domain?: string; industry?: string }

/** A note on a deal, person, organisation or lead — written by the user or a colleague. */
export interface PdNote {
  id: number;
  content: string;
  dealId: number | null;
  personId: number | null;
  orgId: number | null;
  leadId: string | null;
  userId: number | null;
  addTime: string;
  updateTime: string;
}

export interface PdLead {
  id: string;
  title: string;
  personId: number | null;
  orgId: number | null;
  ownerId: number | null;
  value?: { amount: number; currency: string } | null;
  expectedClose: string | null;
  source?: string | null;
  addTime: string;
  updateTime: string;
  archived?: boolean;
}

export interface CrmDirectory {
  emails: Set<string>;
  domains: Set<string>;
}

/** Shared mail domains: a client's gmail address must not file every gmail sender as a client. */
const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "live.co.uk", "msn.com",
  "yahoo.com", "yahoo.co.uk", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com",
  "gmx.com", "gmx.net", "mail.com", "zoho.com", "btinternet.com", "sky.com", "virginmedia.com",
]);

/** "https://www.acme.co.uk/about" → "acme.co.uk". */
export function domainFromWebsite(website?: string | null): string | undefined {
  const w = website?.trim();
  if (!w) return undefined;
  try {
    const host = new URL(/^https?:\/\//i.test(w) ? w : `https://${w}`).hostname.toLowerCase().replace(/^www\./, "");
    return host.includes(".") ? host : undefined;
  } catch {
    // ci-ok: a malformed website field just has no domain
    return undefined;
  }
}

export function emailDomain(email: string): string | undefined {
  const at = email.lastIndexOf("@");
  return at > 0 ? email.slice(at + 1).trim().toLowerCase() : undefined;
}

/**
 * Who counts as a client: every Pipedrive person's email, plus the company
 * domains of organisations (from their website, or from their people's work
 * addresses). Your own company's domain is never a client domain.
 */
export function buildDirectory(persons: readonly PdPerson[], orgs: readonly PdOrg[], ownDomains: readonly string[] = []): CrmDirectory {
  const own = new Set(ownDomains.map((d) => d.toLowerCase()));
  const emails = new Set<string>();
  const domains = new Set<string>();
  const add = (d?: string) => { if (d && !FREE_MAIL.has(d) && !own.has(d)) domains.add(d); };
  for (const o of orgs) add(o.domain ?? domainFromWebsite(o.website));
  const orgIds = new Set(orgs.map((o) => o.id));
  for (const p of persons) {
    for (const e of p.emails) {
      const v = e.trim().toLowerCase();
      if (!v.includes("@")) continue;
      const d = emailDomain(v);
      if (d && own.has(d)) continue;
      emails.add(v);
      // A person's work domain stands for their organisation only when they belong to one.
      if (p.orgId !== null && orgIds.has(p.orgId)) add(d);
    }
  }
  return { emails, domains };
}

export function isClientSender(dir: CrmDirectory | undefined, email?: string): boolean {
  const e = email?.trim().toLowerCase();
  if (!dir || !e) return false;
  if (dir.emails.has(e)) return true;
  const d = emailDomain(e);
  if (!d) return false;
  for (const cd of dir.domains) if (d === cd || d.endsWith(`.${cd}`)) return true;
  return false;
}

/** Activities that need you: overdue, or due today (in the user's day). */
export function dueActivities(acts: readonly PdActivity[], today: string): { overdue: PdActivity[]; dueToday: PdActivity[] } {
  const open = acts.filter((a) => !!a.dueDate);
  return {
    overdue: open.filter((a) => a.dueDate! < today).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!)),
    dueToday: open.filter((a) => a.dueDate === today).sort((a, b) => (a.dueTime ?? "99").localeCompare(b.dueTime ?? "99")),
  };
}

export function daysBetween(fromYmd: string, toYmd: string): number {
  return Math.round((Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / 86_400_000);
}

export function money(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: 0 }).format(value);
  } catch {
    // ci-ok: an unknown currency code still reads fine as "1200 XYZ"
    return `${Math.round(value)} ${currency}`;
  }
}
