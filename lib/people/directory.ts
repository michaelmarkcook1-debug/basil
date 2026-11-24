/**
 * lib/people/directory.ts — one record per person, across every source.
 *
 * Audit 2026-11-24, item 4: email, Slack, the calendar, Pipedrive and memory
 * each matched people by name in their own way. Meeting prep matched email on
 * the sender's display name (so "John" matched every John), calendar
 * attendees often arrive as a bare address, and a Slack ID or a Pipedrive
 * phone number was never tied to anyone.
 *
 * Every source contributes "sightings" (a name with whatever identifiers that
 * source knows: emails, phones, a Slack ID, a contact or Pipedrive id). They
 * are joined into people by these rules:
 *
 *   1. A shared email address, Slack ID or phone number is the same person.
 *   2. The same full name (first and last) joins two records only when their
 *      company email domains don't conflict: "Jane Doe <jane@acme.com>" and
 *      "Jane Doe" in a meeting are one person; Jane Doe at acme.com and
 *      Jane Doe at globex.com stay two.
 *   3. A bare first name never joins anything ("Matt" is not an identity).
 *   4. The user is never in their own directory.
 *   5. The user's own corrections win: "same person" joins two records;
 *      "not the same" keeps two apart that only a shared name would join
 *      (a shared email or Slack ID is the same person by definition).
 *
 * Pure: no I/O. lib/people/directory-store.ts gathers the sightings and stores
 * the result.
 */

export type SightingSource = "contact" | "pipedrive" | "slack" | "calendar" | "email" | "meeting";

export interface Sighting {
  source: SightingSource;
  name?: string;
  emails?: readonly string[];
  phones?: readonly string[];
  slackId?: string;
  company?: string;
  title?: string;
  contactId?: string;
  pipedrivePersonId?: number;
}

export interface Person {
  /** Stable while its anchor identifier lasts: contact:<id>, pd:<id>, email:<addr>, slack:<id>, name:<n>. */
  id: string;
  name: string;
  /** Every name this person goes by, as seen (first is the best). */
  names: string[];
  emails: string[];
  phones: string[];
  slackIds: string[];
  company?: string;
  title?: string;
  contactId?: string;
  pipedrivePersonIds: number[];
  sources: SightingSource[];
}

export interface PeopleLinks {
  /** Pairs of identifiers ("email:a@x.com", "slack:U123", "contact:abc", "pd:42", "name:jane doe") the user said are one person. */
  same?: ReadonlyArray<readonly [string, string]>;
  /** Pairs the user said are different people. */
  different?: ReadonlyArray<readonly [string, string]>;
}

export interface SelfKeys { emails: readonly string[]; names: readonly string[] }

// ── Normalising ──────────────────────────────────────────────────────────────

export function normEmail(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const m = raw.trim().toLowerCase().match(/<?([^\s<>"',;]+@[^\s<>"',;]+\.[a-z]{2,})>?$/);
  if (!m) return null;
  const [local, domain] = m[1].split("@");
  // Gmail ignores dots and +tags; googlemail.com is gmail.com.
  if (domain === "gmail.com" || domain === "googlemail.com") return `${local.split("+")[0].replace(/\./g, "")}@gmail.com`;
  return m[1];
}

/** Digits only, compared on the last 10 — "+44 7700 900123" ≈ "07700900123". Too short to identify anyone → null. */
export function normPhone(raw: string | undefined | null): string | null {
  const d = (raw ?? "").replace(/\D/g, "");
  return d.length >= 9 ? d.slice(-10) : null;
}

export function normName(raw: string | undefined | null): string {
  return (raw ?? "")
    .replace(/\(.*?\)/g, " ")                 // "Jane Doe (Acme)"
    .replace(/^["']|["']$/g, "")
    .toLowerCase()
    .normalize("NFKD").replace(/\p{M}/gu, "")  // José → jose
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "jane a. doe" → "jane doe": first and last word, the key for rule 2. Null for a single word. */
export function fullNameKey(raw: string | undefined | null): string | null {
  const parts = normName(raw).split(" ").filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[0]} ${parts[parts.length - 1]}`;
}

const PUBLIC_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "msn.com",
  "yahoo.com", "yahoo.co.uk", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com",
  "gmx.com", "fastmail.com", "zoho.com", "btinternet.com", "sky.com", "hey.com",
]);

const BOT_LOCAL = /^(no-?reply|do-?not-?reply|donotreply|noreply[-+.].*|.*[-+.]noreply|notifications?|notify|alerts?|mailer-daemon|postmaster|bounces?|automated|calendar-notification|calendar|drive-shares.*|comments-noreply|invitations?|receipts?|invoices?|billing|system|robot|bot|info|hello|team|support|help|sales|contact|enquiries|inquiries|admin|office|accounts|marketing|news|newsletters?|updates?|digest|events|community|careers|jobs|press|partners|success|care)$/;
const BOT_DOMAINS = /(^|\.)(calendar\.google\.com|resource\.calendar\.google\.com|group\.calendar\.google\.com|docs\.google\.com|zoom\.us|slack\.com|linear\.app|github\.com|notion\.so|atlassian\.net|docusign\.(net|com)|calendly\.com|hubspot\.com|hubspotemail\.net|mailchimp\.com|sendgrid\.net|amazonses\.com|intercom-mail\.com|substack\.com|linkedin\.com|stripe\.com|read\.ai|plaud\.ai)$/;

/** A person's own mailbox — not a no-reply, a shared inbox or a room. */
export function isPersonalEmail(email: string): boolean {
  const [local, domain] = email.split("@");
  return !!local && !!domain && !BOT_LOCAL.test(local) && !BOT_DOMAINS.test(domain);
}

const domainOf = (e: string) => e.slice(e.lastIndexOf("@") + 1);
const companyDomains = (emails: Iterable<string>) => new Set([...emails].map(domainOf).filter((d) => !PUBLIC_DOMAINS.has(d)));

const looksLikeName = (n: string) => !!n && !n.includes("@") && !/^[UWB][A-Z0-9]{6,}$/.test(n) && /\p{L}/u.test(n);

// ── Building ─────────────────────────────────────────────────────────────────

class UnionFind {
  private parent: number[];
  constructor(n: number) { this.parent = Array.from({ length: n }, (_, i) => i); }
  find(i: number): number {
    while (this.parent[i] !== i) { this.parent[i] = this.parent[this.parent[i]]; i = this.parent[i]; }
    return i;
  }
  union(a: number, b: number): void { const x = this.find(a), y = this.find(b); if (x !== y) this.parent[y] = x; }
}

/** The identifier keys a sighting carries (the forms PeopleLinks uses). */
function keysOf(s: Sighting): string[] {
  const keys: string[] = [];
  for (const e of s.emails ?? []) { const n = normEmail(e); if (n && isPersonalEmail(n)) keys.push(`email:${n}`); }
  for (const p of s.phones ?? []) { const n = normPhone(p); if (n) keys.push(`phone:${n}`); }
  if (s.slackId && /^[UW][A-Z0-9]{2,}$/.test(s.slackId.trim())) keys.push(`slack:${s.slackId.trim()}`);
  if (s.contactId) keys.push(`contact:${s.contactId}`);
  if (s.pipedrivePersonId != null) keys.push(`pd:${s.pipedrivePersonId}`);
  return keys;
}

/** A correction's identifier in the form sightings are keyed by ("Slack:u0ab" → "slack:U0AB", "email:Jane.Doe@x.com" → "email:jane.doe@x.com"). */
export function normLinkKey(raw: string): string {
  const v = raw.trim();
  const i = v.indexOf(":");
  const kind = i > 0 ? v.slice(0, i).toLowerCase() : "";
  const rest = i > 0 ? v.slice(i + 1).trim() : v;
  switch (kind) {
    case "email": return `email:${normEmail(rest) ?? rest.toLowerCase()}`;
    case "slack": return `slack:${rest.toUpperCase()}`;
    case "phone": return `phone:${normPhone(rest) ?? rest}`;
    case "name": return `name:${fullNameKey(rest) ?? normName(rest)}`;
    case "contact": case "pd": return `${kind}:${rest}`;
    default: return v;
  }
}

const SOURCE_RANK: Record<SightingSource, number> = { contact: 0, pipedrive: 1, slack: 2, calendar: 3, email: 4, meeting: 5 };

/**
 * Join sightings into people. Deterministic for the same input (order of
 * sightings does not change who is joined to whom).
 */
export function buildPeople(sightings: readonly Sighting[], self: SelfKeys, links: PeopleLinks = {}): Person[] {
  const selfEmails = new Set(self.emails.map((e) => normEmail(e)).filter(Boolean) as string[]);
  const selfNames = new Set(self.names.map(normName).filter((n) => n.includes(" ")));
  const isSelfSighting = (s: Sighting) =>
    (s.emails ?? []).some((e) => { const n = normEmail(e); return !!n && selfEmails.has(n); }) ||
    (!!s.name && selfNames.has(normName(s.name)));

  // Only sightings that can identify someone: at least one key, or a full name.
  const list = sightings.filter((s) => !isSelfSighting(s)).map((s) => ({ s, keys: keysOf(s), full: fullNameKey(s.name && looksLikeName(s.name) ? s.name : "") }))
    .filter((x) => x.keys.length > 0 || x.full);
  const uf = new UnionFind(list.length);

  // Rule 1 (and the user's "same person" pairs, via shared keys).
  const firstWithKey = new Map<string, number>();
  list.forEach((x, i) => {
    for (const k of x.keys) {
      const j = firstWithKey.get(k);
      if (j === undefined) firstWithKey.set(k, i); else uf.union(j, i);
    }
    if (x.full) { const k = `name:${x.full}`; if (!firstWithKey.has(k)) firstWithKey.set(k, i); }
  });

  // "Not the same" pairs: which roots must stay apart.
  const apart = (links.different ?? []).map(([a, b]) => [normLinkKey(a), normLinkKey(b)] as const);
  const keyIndex = (k: string) => firstWithKey.get(normLinkKey(k));
  // Does this group hold the identifier? A "name:" key means anyone in it goes by that full name.
  const rootHas = (root: number, key: string) => list.some((x, i) => uf.find(i) === root &&
    (key.startsWith("name:") ? `name:${x.full}` === key : x.keys.includes(key)));
  const blocked = (ra: number, rb: number) => apart.some(([a, b]) =>
    (rootHas(ra, a) && rootHas(rb, b)) || (rootHas(ra, b) && rootHas(rb, a)));

  // Rule 2: same full name, no conflicting company domain. Done per name
  // group so the outcome does not depend on order: every component in the
  // group must be compatible with every other, or the name joins nothing.
  const byName = new Map<string, Set<number>>();
  list.forEach((x, i) => { if (x.full) byName.set(x.full, (byName.get(x.full) ?? new Set()).add(i)); });
  const domainsOfRoot = (root: number) => {
    const emails: string[] = [];
    list.forEach((x, i) => { if (uf.find(i) === root) for (const k of x.keys) if (k.startsWith("email:")) emails.push(k.slice(6)); });
    return companyDomains(emails);
  };
  for (const idxs of byName.values()) {
    const roots = [...new Set([...idxs].map((i) => uf.find(i)))];
    if (roots.length < 2) continue;
    const domainSets = roots.map(domainsOfRoot);
    const withDomain = domainSets.filter((d) => d.size > 0);
    // Compatible when every company-domain set shares a domain with every other (empty sets fit anything).
    const compatible = withDomain.every((a) => withDomain.every((b) => [...a].some((d) => b.has(d))));
    if (!compatible) continue;
    for (let i = 1; i < roots.length; i++) {
      const a = uf.find(roots[0]), b = uf.find(roots[i]);
      if (a !== b && !blocked(a, b)) uf.union(a, b);
    }
  }

  // The user's explicit "same person" pairs.
  for (const [a, b] of links.same ?? []) {
    const ia = keyIndex(a), ib = keyIndex(b);
    if (ia !== undefined && ib !== undefined) uf.union(ia, ib);
  }

  // Assemble.
  const groups = new Map<number, typeof list>();
  list.forEach((x, i) => { const r = uf.find(i); groups.set(r, [...(groups.get(r) ?? []), x]); });
  const people: Person[] = [];
  for (const members of groups.values()) {
    const ss = [...members].sort((a, b) => SOURCE_RANK[a.s.source] - SOURCE_RANK[b.s.source]);
    const names: string[] = [];
    const seenNames = new Set<string>();
    // Best name first: a contact's, then Pipedrive's…; multi-word before single.
    const nameCands = ss.map((x) => x.s.name?.trim() ?? "").filter(looksLikeName);
    for (const n of [...nameCands.filter((n) => n.includes(" ")), ...nameCands.filter((n) => !n.includes(" "))]) {
      const k = normName(n);
      if (k && !seenNames.has(k)) { seenNames.add(k); names.push(n.replace(/\s+/g, " ")); }
    }
    const uniq = (xs: Array<string | null | undefined>) => [...new Set(xs.filter(Boolean) as string[])];
    const emails = uniq(ss.flatMap((x) => x.keys.filter((k) => k.startsWith("email:")).map((k) => k.slice(6))));
    const phones = uniq(ss.flatMap((x) => (x.s.phones ?? []).map((p) => p.trim()).filter((p) => normPhone(p))));
    const slackIds = uniq(ss.map((x) => x.s.slackId?.trim()));
    const contactId = ss.find((x) => x.s.contactId)?.s.contactId;
    const pdIds = [...new Set(ss.map((x) => x.s.pipedrivePersonId).filter((v): v is number => v != null))];
    const name = names[0] ?? emails[0] ?? slackIds[0] ?? "Unknown";
    const id = contactId ? `contact:${contactId}` : pdIds.length ? `pd:${Math.min(...pdIds)}`
      : emails.length ? `email:${[...emails].sort()[0]}` : slackIds.length ? `slack:${[...slackIds].sort()[0]}`
      : `name:${fullNameKey(name) ?? normName(name)}`;
    people.push({
      id, name, names: names.length ? names : [name], emails, phones: dedupePhones(phones), slackIds,
      company: ss.find((x) => x.s.company?.trim())?.s.company?.trim(),
      title: ss.find((x) => x.s.title?.trim())?.s.title?.trim(),
      contactId, pipedrivePersonIds: pdIds,
      sources: [...new Set(ss.map((x) => x.s.source))],
    });
  }
  return people.sort((a, b) => b.sources.length - a.sources.length || a.name.localeCompare(b.name));
}

function dedupePhones(phones: string[]): string[] {
  const seen = new Set<string>();
  return phones.filter((p) => { const k = normPhone(p)!; if (seen.has(k)) return false; seen.add(k); return true; });
}

// ── Looking people up ────────────────────────────────────────────────────────

export interface PeopleIndex {
  people: readonly Person[];
  byEmail: Map<string, Person>;
  bySlack: Map<string, Person>;
  byPhone: Map<string, Person>;
  byFullName: Map<string, Person[]>;
  byBareName: Map<string, Person[]>;
}

export function indexPeople(people: readonly Person[]): PeopleIndex {
  const ix: PeopleIndex = { people, byEmail: new Map(), bySlack: new Map(), byPhone: new Map(), byFullName: new Map(), byBareName: new Map() };
  const push = (m: Map<string, Person[]>, k: string, p: Person) => { const cur = m.get(k) ?? []; if (!cur.includes(p)) m.set(k, [...cur, p]); };
  for (const p of people) {
    for (const e of p.emails) ix.byEmail.set(e, p);
    for (const s of p.slackIds) ix.bySlack.set(s, p);
    for (const ph of p.phones) { const n = normPhone(ph); if (n) ix.byPhone.set(n, p); }
    for (const n of p.names) {
      const full = fullNameKey(n);
      if (full) push(ix.byFullName, full, p);
      else { const bare = normName(n); if (bare) push(ix.byBareName, bare, p); }
    }
  }
  return ix;
}

/**
 * Who this is — an email address, a Slack ID, a phone number or a name.
 * A name must point at exactly one person: a full name by first and last
 * name, a single word only when one person is known by exactly that word
 * alone (a Slack handle, say) and nobody else shares it as a first name.
 */
export function findPerson(ix: PeopleIndex, raw: string | undefined | null): Person | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  // "Jane Doe <jane@acme.com>"
  const email = normEmail(v);
  if (email) {
    const p = ix.byEmail.get(email);
    if (p) return p;
    const name = v.replace(/<[^>]*>/, "").trim();
    return name && name !== v ? findPerson(ix, name) : null;
  }
  if (/^[UW][A-Z0-9]{6,}$/.test(v)) return ix.bySlack.get(v) ?? null;
  if (/^\+?[\d\s().-]{9,}$/.test(v)) { const n = normPhone(v); return n ? ix.byPhone.get(n) ?? null : null; }
  const full = fullNameKey(v);
  if (full) { const hits = ix.byFullName.get(full) ?? []; return hits.length === 1 ? hits[0] : null; }
  const bare = normName(v);
  const hits = ix.byBareName.get(bare) ?? [];
  if (hits.length !== 1) return null;
  const firstNameSharers = ix.people.filter((p) => p !== hits[0] && p.names.some((n) => normName(n).split(" ")[0] === bare));
  return firstNameSharers.length ? null : hits[0];
}

export interface Identifiers {
  people: Person[];
  names: string[];
  emails: string[];
  slackIds: string[];
  phones: string[];
  /** Inputs that matched nobody — still usable as plain names / addresses. */
  unresolved: string[];
}

/**
 * Everything these people are known by, for matching messages, meetings and
 * CRM records. Unresolved inputs are passed through (as a name, or an email
 * if they are one) so callers never lose what they had.
 */
export function identifiersFor(ix: PeopleIndex, inputs: readonly string[]): Identifiers {
  const people: Person[] = [];
  const unresolved: string[] = [];
  for (const raw of inputs) {
    const p = findPerson(ix, raw);
    if (p) { if (!people.includes(p)) people.push(p); } else if (raw.trim()) unresolved.push(raw.trim());
  }
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];
  return {
    people,
    names: uniq([...people.flatMap((p) => p.names), ...unresolved.filter((u) => !normEmail(u))]),
    emails: uniq([...people.flatMap((p) => p.emails), ...unresolved.map((u) => normEmail(u) ?? "")]),
    slackIds: uniq(people.flatMap((p) => p.slackIds)),
    phones: uniq(people.flatMap((p) => p.phones)),
    unresolved,
  };
}

/** Is this sender (a "Name" + address pair, as messages carry) one of these people? */
export function isFrom(ids: Pick<Identifiers, "emails" | "names" | "slackIds">, from: { email?: string; name?: string; slackId?: string }): boolean {
  const e = normEmail(from.email);
  if (e && ids.emails.some((x) => normEmail(x) === e)) return true;
  if (from.slackId && ids.slackIds.includes(from.slackId)) return true;
  const full = fullNameKey(from.name);
  if (full) return ids.names.some((n) => fullNameKey(n) === full);
  return false;
}

/** One person as a prompt line: what Basil knows them by, everywhere. */
export function personLine(p: Person): string {
  const bits = [
    p.names.length > 1 ? `also "${p.names.slice(1, 4).join('", "')}"` : "",
    p.title || p.company ? [p.title, p.company].filter(Boolean).join(", ") : "",
    p.emails.length ? p.emails.slice(0, 3).join(", ") : "",
    p.slackIds.length ? "on Slack" : "",
    p.pipedrivePersonIds.length ? "in Pipedrive" : "",
    p.contactId ? "a Basil contact" : "",
  ].filter(Boolean);
  return `${p.name}${bits.length ? ` — ${bits.join(" · ")}` : ""}`;
}

/** "Jane Doe <jane@acme.com>, bob@x.com, \"Doe, John\" <john@y.com>" → [{name, email}]. Pure. */
export function parseAddressList(header: string | undefined | null): Array<{ name?: string; email: string }> {
  const out: Array<{ name?: string; email: string }> = [];
  const re = /\s*(?:"([^"]*)"|([^,<"]*?))\s*<([^>]+)>|([^\s,<>"]+@[^\s,<>"]+)/g;
  for (const m of (header ?? "").matchAll(re)) {
    const email = (m[3] ?? m[4] ?? "").trim();
    if (!email.includes("@")) continue;
    const name = (m[1] ?? m[2] ?? "").trim();
    out.push(name ? { name, email } : { email });
  }
  return out;
}
