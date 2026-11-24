/**
 * lib/people/directory-store.ts — gathering sightings from every source and
 * keeping the joined people directory (lib/people/directory.ts).
 *
 * Rebuilt once a day by the 05:30 cron (after the Pipedrive read) and on first
 * use; a copy older than 30 hours is served while a fresh one is built behind
 * it. Sources, each optional — a failing one is skipped, never fatal:
 *   - Basil contacts (name, email, phone, company, title)
 *   - Pipedrive people (the stored daily copy; no Pipedrive call)
 *   - Slack members (users.list: real name, display name, email, phone, ID)
 *   - the calendar, 60 days back to 30 ahead (attendee name + address)
 *   - email headers, last 45 days (sender and recipients, name + address)
 *   - meeting history attendees (names; an address when there is one guest)
 *
 * The user's own corrections live in people-links.json.
 */
import "server-only";
import { readUserStore, writeUserStore, updateUserStore } from "@/lib/storage/user-store";
import { listUserContacts } from "@/lib/contacts/user-store";
import { getStoredPipedriveSnapshot } from "@/lib/pipedrive/client";
import { getSlackBotClientForUser, getSlackUserClientForUser } from "@/lib/slack/client";
import { readCalendar } from "@/lib/calendar/unified";
import { searchEmails } from "@/lib/google/gmail";
import { readMeetingHistory } from "@/lib/meetings/history-store";
import { getSelfIdentity } from "@/lib/self-identity";
import {
  buildPeople, indexPeople, normLinkKey, parseAddressList,
  type PeopleIndex, type PeopleLinks, type Person, type Sighting, type SightingSource,
} from "@/lib/people/directory";

const FILE = "people-directory.json";
const LINKS_FILE = "people-links.json";
const STALE_MS = 30 * 60 * 60 * 1000;
const MEMORY_MS = 5 * 60 * 1000;

interface Stored { v: 1; builtAt: string; counts: Partial<Record<SightingSource, number>>; people: Person[] }

const memory = new Map<string, { ix: PeopleIndex; builtAt: string; readAt: number }>();
const inflight = new Map<string, Promise<Stored>>();

const warn = (what: string) => (e: unknown) => {
  console.warn(`[people] ${what} unavailable for the directory:`, e instanceof Error ? e.message : e);
  return null;
};

interface SlackMember {
  id: string; deleted?: boolean; is_bot?: boolean; name?: string; real_name?: string;
  profile?: { email?: string; real_name?: string; display_name?: string; phone?: string; title?: string };
}

async function slackSightings(username: string): Promise<Sighting[]> {
  const web = (await getSlackBotClientForUser(username)) ?? (await getSlackUserClientForUser(username));
  if (!web) return [];
  const members: SlackMember[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const res = (await web.users.list({ limit: 200, cursor })) as { members?: SlackMember[]; response_metadata?: { next_cursor?: string } };
    members.push(...(res.members ?? []));
    cursor = res.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  const out: Sighting[] = [];
  for (const m of members) {
    if (m.deleted || m.is_bot || m.id === "USLACKBOT") continue;
    const base = { source: "slack" as const, slackId: m.id, emails: m.profile?.email ? [m.profile.email] : [], phones: m.profile?.phone ? [m.profile.phone] : [], title: m.profile?.title || undefined };
    const real = m.profile?.real_name || m.real_name;
    out.push({ ...base, name: real || m.profile?.display_name || m.name });
    const display = m.profile?.display_name;
    if (display && display !== real) out.push({ source: "slack", slackId: m.id, name: display }); // "jdoe" / "Jane" — another name for the same ID
  }
  return out;
}

async function calendarSightings(username: string, tz: string): Promise<Sighting[]> {
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const cal = await readCalendar(username, { from: day(-60), to: day(30) }, tz);
  const out: Sighting[] = [];
  for (const e of cal.events) {
    const details = (e as { attendeeDetails?: Array<{ name?: string; email?: string }> }).attendeeDetails ?? [];
    for (const a of details) if (a.email) out.push({ source: "calendar", name: a.name || undefined, emails: [a.email] });
    const org = e as { organizerName?: string; organizerEmail?: string };
    if (org.organizerEmail) out.push({ source: "calendar", name: org.organizerName, emails: [org.organizerEmail] });
  }
  return out;
}

async function emailSightings(username: string): Promise<Sighting[]> {
  const [inbox, sent] = await Promise.all([
    searchEmails(username, "in:inbox", 100, 45).catch(warn("inbox")),
    searchEmails(username, "in:sent", 60, 45).catch(warn("sent mail")),
  ]);
  const out: Sighting[] = [];
  for (const m of inbox ?? []) if (m.fromEmail) out.push({ source: "email", name: m.from && !m.from.includes("@") ? m.from : undefined, emails: [m.fromEmail] });
  for (const m of sent ?? []) for (const a of parseAddressList(m.to)) out.push({ source: "email", name: a.name, emails: [a.email] });
  return out;
}

async function meetingSightings(username: string): Promise<Sighting[]> {
  const out: Sighting[] = [];
  for (const m of await readMeetingHistory(username)) {
    if (m.attendees.length === 1 && m.attendeeEmails.length === 1) {
      out.push({ source: "meeting", name: m.attendees[0], emails: m.attendeeEmails });
      continue;
    }
    for (const n of m.attendees) out.push({ source: "meeting", name: n });
    for (const e of m.attendeeEmails) out.push({ source: "meeting", emails: [e] });
  }
  return out;
}

export async function readPeopleLinks(username: string): Promise<PeopleLinks> {
  return readUserStore<PeopleLinks>(username, LINKS_FILE, {}, { fresh: true });
}

/** Record the user's correction, then rebuild so it applies at once. */
export async function addPeopleLink(username: string, kind: "same" | "different", a: string, b: string): Promise<void> {
  const pair = [normLinkKey(a), normLinkKey(b)] as const;
  await updateUserStore<PeopleLinks>(username, LINKS_FILE, (cur) => {
    const same = (cur?.same ?? []).filter(([x, y]) => !(x === pair[0] && y === pair[1]) && !(x === pair[1] && y === pair[0]));
    const different = (cur?.different ?? []).filter(([x, y]) => !(x === pair[0] && y === pair[1]) && !(x === pair[1] && y === pair[0]));
    return kind === "same" ? { same: [...same, pair], different } : { same, different: [...different, pair] };
  }, {});
  await rebuildPeopleDirectory(username);
}

/** Gather every source and store a fresh directory. Never throws for a missing source. */
export async function rebuildPeopleDirectory(username: string, opts: { tz?: string } = {}): Promise<Stored> {
  const running = inflight.get(username);
  if (running) return running;
  const job = (async () => {
    const [self, links, contacts, pd, slack, cal, mail, meetings] = await Promise.all([
      getSelfIdentity(username),
      readPeopleLinks(username).catch(() => ({} as PeopleLinks)), // ci-ok: no corrections yet → none apply
      listUserContacts(username).catch(warn("contacts")),
      getStoredPipedriveSnapshot(username).catch(warn("Pipedrive")),
      slackSightings(username).catch(warn("Slack")),
      calendarSightings(username, opts.tz ?? "Europe/London").catch(warn("calendar")),
      emailSightings(username).catch(warn("email")),
      meetingSightings(username).catch(warn("meeting history")),
    ]);
    const orgName = new Map((pd?.orgs ?? []).map((o) => [o.id, o.name]));
    const sightings: Sighting[] = [
      ...(contacts ?? []).map((c): Sighting => ({
        source: "contact", contactId: c.id, name: c.name, emails: c.email ? [c.email] : [], phones: c.phone ? [c.phone] : [],
        company: c.company || undefined, title: c.title || undefined,
      })),
      ...(pd?.persons ?? []).map((p): Sighting => ({
        source: "pipedrive", pipedrivePersonId: p.id, name: p.name, emails: p.emails, phones: p.phones ?? [],
        company: p.orgId != null ? orgName.get(p.orgId) : undefined, title: p.jobTitle,
      })),
      ...(slack ?? []), ...(cal ?? []), ...(mail ?? []), ...(meetings ?? []),
    ];
    const people = buildPeople(sightings, self, links);
    const counts: Stored["counts"] = {
      contact: contacts?.length ?? 0, pipedrive: pd?.persons.length ?? 0, slack: slack?.length ?? 0,
      calendar: cal?.length ?? 0, email: mail?.length ?? 0, meeting: meetings?.length ?? 0,
    };
    const stored: Stored = { v: 1, builtAt: new Date().toISOString(), counts, people };
    await writeUserStore(username, FILE, stored);
    memory.set(username, { ix: indexPeople(people), builtAt: stored.builtAt, readAt: Date.now() });
    const linked = people.filter((p) => p.sources.length > 1).length;
    console.log(`[people] ${username}: ${people.length} people from ${sightings.length} sightings (${linked} seen in more than one source)`, counts);
    return stored;
  })();
  inflight.set(username, job);
  try { return await job; } finally { inflight.delete(username); }
}

/**
 * The directory, indexed for lookups. Builds it on first use; a copy older
 * than 30 hours is returned as is and rebuilt behind the request.
 */
export async function getPeopleIndex(username: string): Promise<PeopleIndex> {
  const hot = memory.get(username);
  if (hot && Date.now() - hot.readAt < MEMORY_MS) return hot.ix;
  const stored = await readUserStore<Stored | null>(username, FILE, null, { fresh: true }).catch(warn("stored directory"));
  if (!stored?.people) return indexPeople((await rebuildPeopleDirectory(username)).people);
  const ix = indexPeople(stored.people);
  memory.set(username, { ix, builtAt: stored.builtAt, readAt: Date.now() });
  if (Date.now() - Date.parse(stored.builtAt) > STALE_MS) {
    void rebuildPeopleDirectory(username).catch(warn("rebuild"));
  }
  return ix;
}

/**
 * For requests the user is waiting on (meeting prep, Ask Basil): never builds
 * the directory inline — the first build reads Gmail and Slack and can take a
 * while — and never throws. Before the first build it returns an empty index
 * (callers fall back to plain names) and starts the build.
 */
export async function getPeopleIndexSafe(username: string): Promise<PeopleIndex> {
  try {
    const hot = memory.get(username);
    if (hot && Date.now() - hot.readAt < MEMORY_MS) return hot.ix;
    const stored = await readUserStore<Stored | null>(username, FILE, null, { fresh: true });
    if (!stored?.people) {
      void rebuildPeopleDirectory(username).catch(warn("first build"));
      return indexPeople([]);
    }
    return await getPeopleIndex(username);
  } catch (e) {
    console.warn("[people] directory unavailable:", e instanceof Error ? e.message : e);
    return indexPeople([]);
  }
}
