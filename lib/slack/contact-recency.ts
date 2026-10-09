import "server-only";
import type { WebClient } from "@slack/web-api";
import { getSlackBotClientForUser, getSlackUserClientForUser } from "@/lib/slack/client";
import { listUserContacts } from "@/lib/contacts/user-store";
import type { RecencyTouch } from "@/lib/contacts/touch-recency";

/**
 * When did you last talk with each contact on Slack?
 *
 * The ingest fetch (getRecentSlackMessages) samples ~40 conversations, five
 * top-level messages each, no thread replies — built for classifying new
 * messages, not for answering "have we spoken lately?". People Michael talks to
 * daily were listed as gone quiet because their conversations fell outside it.
 *
 * This answers the recency question directly, per contact, with the two things
 * Basil's tokens can do:
 *   - bot token (users:read, users:read.email): match contacts to Slack users
 *   - user token (search:read): the newest message between you and them —
 *     DMs, group DMs and thread replies, in either direction
 * No message text is stored or sent to a model; only dates come back.
 */

export interface SlackMember {
  id: string;
  name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  real_name?: string;
  profile?: { email?: string; real_name?: string; display_name?: string };
}

export interface SearchMatch {
  ts?: string;
  user?: string;
  text?: string;
  permalink?: string;
  channel?: { id?: string; name?: string; is_im?: boolean; is_mpim?: boolean; user?: string };
}

interface ContactLike { id: string; name: string; email?: string; lastInteraction?: string }

const norm = (s?: string) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Contact → Slack user id. Email first (exact); otherwise a full name that is
 * unique among workspace members — two "Sam Patel"s match neither. Pure.
 */
export function matchContactsToSlack(contacts: readonly ContactLike[], members: readonly SlackMember[]): Map<string, string> {
  const live = members.filter((m) => !m.deleted && !m.is_bot && m.id !== "USLACKBOT");
  const byEmail = new Map<string, string>();
  const byName = new Map<string, string[]>();
  for (const m of live) {
    const e = norm(m.profile?.email);
    if (e) byEmail.set(e, m.id);
    for (const n of new Set([norm(m.real_name), norm(m.profile?.real_name)].filter(Boolean))) {
      byName.set(n, [...(byName.get(n) ?? []), m.id]);
    }
  }
  const out = new Map<string, string>();
  for (const c of contacts) {
    const viaEmail = c.email ? byEmail.get(norm(c.email)) : undefined;
    const viaName = byName.get(norm(c.name));
    const id = viaEmail ?? (viaName && new Set(viaName).size === 1 ? viaName[0] : undefined);
    if (id) out.set(c.id, id);
  }
  return out;
}

/** In a thread? Slack puts thread_ts in a reply's permalink. */
const inThread = (m: SearchMatch) => /[?&]thread_ts=/.test(m.permalink ?? "");

/**
 * Was this message (by the contact) part of talking WITH you — rather than a
 * post in a channel you happen to share? DMs, group DMs, thread replies, or a
 * message that mentions you. Pure.
 */
export function countsAsContactWithYou(m: SearchMatch, selfId: string): boolean {
  if (m.channel?.is_im || m.channel?.is_mpim) return true;
  if (inThread(m)) return true;
  return !!selfId && (m.text ?? "").includes(`<@${selfId}>`);
}

/**
 * Who a message YOU sent was to: the other person in a DM, the people in a
 * group DM ("mpdm-alice--bob-1" lists usernames), and anyone you @mentioned. Pure.
 */
export function counterpartsOf(m: SearchMatch, selfId: string, idByUsername: ReadonlyMap<string, string>): string[] {
  const ids = new Set<string>();
  const ch = m.channel ?? {};
  if (ch.is_im) {
    const other = ch.user ?? (/^[UW][A-Z0-9]{6,}$/.test(ch.name ?? "") ? ch.name : undefined);
    if (other) ids.add(other);
  }
  if (ch.is_mpim && ch.name?.startsWith("mpdm-")) {
    for (const u of ch.name.slice(5).replace(/-\d+$/, "").split("--")) {
      const id = idByUsername.get(u);
      if (id) ids.add(id);
    }
  }
  for (const [, id] of (m.text ?? "").matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)) ids.add(id);
  ids.delete(selfId);
  return [...ids];
}

const isRateLimited = (err: unknown) => {
  const e = err as { code?: string; data?: { error?: string } } | undefined;
  return e?.code === "slack_webapi_rate_limited_error" || e?.data?.error === "ratelimited";
};
const tsToIso = (ts?: string) => (ts ? new Date(parseFloat(ts) * 1000).toISOString() : "");

export interface ScanResult { touches: RecencyTouch[]; searches: number; matchedContacts: number; stoppedEarly: boolean }

export async function scanSlackContactRecency(
  username: string,
  opts: { days?: number; maxSearches?: number; paceMs?: number; now?: number } = {},
  deps: { user?: WebClient | null; bot?: WebClient | null; contacts?: ContactLike[] } = {},
): Promise<ScanResult> {
  const empty: ScanResult = { touches: [], searches: 0, matchedContacts: 0, stoppedEarly: false };
  const user = deps.user !== undefined ? deps.user : await getSlackUserClientForUser(username);
  if (!user) return empty; // search needs the user token
  const directory = (deps.bot !== undefined ? deps.bot : await getSlackBotClientForUser(username)) ?? user;
  const paceMs = opts.paceMs ?? 3_100; // search.messages allows ~20/min
  const maxSearches = opts.maxSearches ?? 40;
  const after = new Date((opts.now ?? Date.now()) - (opts.days ?? 30) * 86_400_000).toISOString().slice(0, 10);

  let selfId = "";
  try { selfId = ((await user.auth.test()) as { user_id?: string }).user_id ?? ""; } catch (err) {
    console.warn("[slack-recency] auth.test failed:", err instanceof Error ? err.message : err);
    return empty;
  }

  const members: SlackMember[] = [];
  try {
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const res = (await directory.users.list({ limit: 200, cursor })) as { members?: SlackMember[]; response_metadata?: { next_cursor?: string } };
      members.push(...(res.members ?? []));
      cursor = res.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
  } catch (err) {
    console.warn("[slack-recency] users.list failed:", err instanceof Error ? err.message : err);
    return empty;
  }

  const contacts = deps.contacts ?? await listUserContacts(username);
  const slackIdOf = matchContactsToSlack(contacts, members);
  const contactBySlackId = new Map<string, ContactLike>();
  for (const c of contacts) { const id = slackIdOf.get(c.id); if (id) contactBySlackId.set(id, c); }
  const idByUsername = new Map(members.filter((m) => m.name).map((m) => [m.name as string, m.id]));

  const latest = new Map<string, string>(); // contact id → newest ISO date
  const credit = (c: ContactLike | undefined, iso: string) => {
    if (c && iso && (!latest.has(c.id) || iso > latest.get(c.id)!)) latest.set(c.id, iso);
  };
  let searches = 0, stoppedEarly = false;
  const search = async (query: string, count: number, page = 1): Promise<SearchMatch[] | null> => {
    if (searches >= maxSearches) { stoppedEarly = true; return null; }
    if (searches > 0 && paceMs > 0) await new Promise((r) => setTimeout(r, paceMs));
    searches++;
    try {
      const res = (await user.search.messages({ query, count, page, sort: "timestamp", sort_dir: "desc" })) as { messages?: { matches?: SearchMatch[]; paging?: { pages?: number } } };
      return res.messages?.matches ?? [];
    } catch (err) {
      if (isRateLimited(err)) { stoppedEarly = true; return null; }
      console.warn(`[slack-recency] search failed (${query.split(" ")[0]}):`, err instanceof Error ? err.message : err);
      return [];
    }
  };

  // 1. Your own messages — who were they to?
  for (let page = 1; page <= 3 && !stoppedEarly; page++) {
    const mine = await search(`from:me after:${after}`, 100, page);
    if (!mine) break;
    for (const m of mine) for (const id of counterpartsOf(m, selfId, idByUsername)) credit(contactBySlackId.get(id), tsToIso(m.ts));
    if (mine.length < 100) break;
  }

  // 2. Each contact's own messages to you — stalest contacts first, since
  //    they are the ones the Relationships panel would flag.
  const order = [...contactBySlackId.entries()].sort(([, a], [, b]) => (a.lastInteraction ?? "").localeCompare(b.lastInteraction ?? ""));
  for (const [slackId, c] of order) {
    if (stoppedEarly) break;
    const theirs = await search(`from:<@${slackId}> after:${after}`, 20);
    if (!theirs) break;
    const hit = theirs.find((m) => countsAsContactWithYou(m, selfId));
    if (hit) credit(c, tsToIso(hit.ts));
  }

  const touches: RecencyTouch[] = [];
  for (const c of contacts) {
    const iso = latest.get(c.id);
    if (iso) touches.push({ name: c.name, email: c.email, date: iso, source: "slack" });
  }
  if (stoppedEarly) console.warn(`[slack-recency] ${username}: stopped after ${searches} searches (limit or rate limit) — partial results kept`);
  return { touches, searches, matchedContacts: contactBySlackId.size, stoppedEarly };
}
