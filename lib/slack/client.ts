import { WebClient, LogLevel } from "@slack/web-api";
import { getIntegrationToken, saveIntegrationToken, deleteIntegrationToken } from "@/lib/storage/secure-token-store";
import { renderSlackText } from "@/lib/slack/render";
import { isEnvCredentialOwner } from "@/lib/auth/env-credential-owner";

export interface SlackConfig {
  botToken?:  string;
  userToken?: string;
  /**
   * Workspace ownership metadata — persisted at OAuth connect time so that
   * webhook events can be deterministically routed to the correct Basil user
   * without first-match guessing.
   *
   * team_id is the canonical Slack workspace identifier and is the primary
   * key used by resolveSlackUserByTeam().  Never null for Slack bot installs.
   */
  teamId?:      string;   // T0XXXXXXXXX — Slack workspace ID
  teamName?:    string;   // Human-readable workspace name (cosmetic only)
  enterpriseId?: string;  // E0XXXXXXXXX — present only for Enterprise Grid installs
  authUserId?:  string;   // U0XXXXXXXXX — Slack user who authorised the install
  botUserId?:   string;   // U0XXXXXXXXX — the bot's own Slack user ID
  scopes?:      string;   // Space-delimited bot scope string from OAuth response
  connectedAt?: string;   // ISO timestamp of initial connection
}

export async function getSlackConfig(username: string): Promise<SlackConfig> {
  const stored = await getIntegrationToken<SlackConfig>(username, "slack");

  // Fall back to env-var tokens when no stored OAuth config exists — for the
  // deployment owner only. These tokens are the owner's Slack; any other login
  // falling back to them would read the owner's DMs.
  const envOk      = isEnvCredentialOwner(username);
  const botToken   = stored?.botToken   ?? (envOk ? process.env.SLACK_BOT_TOKEN : undefined);
  const userToken  = stored?.userToken  ?? (envOk ? process.env.SLACK_USER_TOKEN : undefined);

  return {
    botToken,
    userToken,
    teamId:       stored?.teamId,
    teamName:     stored?.teamName,
    enterpriseId: stored?.enterpriseId,
    authUserId:   stored?.authUserId,
    botUserId:    stored?.botUserId,
    scopes:       stored?.scopes,
    connectedAt:  stored?.connectedAt,
  };
}

export async function saveSlackConfig(username: string, config: SlackConfig): Promise<void> {
  await saveIntegrationToken(username, "slack", config);
  // Invalidate cached clients for this user
  botClientCache.delete(username);
  userClientCache.delete(username);
}

export async function deleteSlackConfig(username: string): Promise<void> {
  await deleteIntegrationToken(username, "slack");
  botClientCache.delete(username);
  userClientCache.delete(username);
}

export async function isSlackConnected(username: string): Promise<boolean> {
  const config = await getSlackConfig(username);
  return !!(config.botToken || config.userToken);
}

// ── Client caches (per-user) ─────────────────────────────────────────────────

// Fail fast instead of silently retrying under rate limits —
// a hung Slack call blocks the entire dashboard and meeting-prep generation.
const clientOptions = {
  retryConfig: { retries: 0 },
  rejectRateLimitedCalls: true,
  logLevel: LogLevel.ERROR,
} as const;

const botClientCache  = new Map<string, WebClient>();
const userClientCache = new Map<string, WebClient>();

export async function getSlackBotClientForUser(username: string): Promise<WebClient | null> {
  const cached = botClientCache.get(username);
  if (cached) return cached;
  const config = await getSlackConfig(username);
  if (!config.botToken) return null;
  const client = new WebClient(config.botToken, clientOptions);
  botClientCache.set(username, client);
  return client;
}

export async function getSlackUserClientForUser(username: string): Promise<WebClient | null> {
  const cached = userClientCache.get(username);
  if (cached) return cached;
  const config = await getSlackConfig(username);
  if (!config.userToken) return null;
  const client = new WebClient(config.userToken, clientOptions);
  userClientCache.set(username, client);
  return client;
}

// ── Legacy (env-var based) helpers kept for backward compat ──────────────────

/** @deprecated Use getSlackBotClientForUser(username) */
export function getSlackBotClient(): WebClient | null {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return null;
  return new WebClient(token, clientOptions);
}

/** @deprecated Use getSlackUserClientForUser(username) */
export function getSlackUserClient(): WebClient | null {
  const token = process.env.SLACK_USER_TOKEN;
  if (!token) return null;
  return new WebClient(token, clientOptions);
}

export function getSlackClient(): WebClient | null {
  return getSlackBotClient();
}

export interface SlackMessage {
  id: string;
  channel: string;
  /** Slack channel/conversation id (e.g. "D01ABC...", "G01XYZ...", "C01...") */
  channelId?: string;
  /** For DMs and Group DMs: lowercased first-names of non-self members. Lets the UI match on identity. */
  channelMembers?: string[];
  author: string;
  text: string;
  date: string;
  isMention: boolean;
  /** True when the message was sent BY the user themselves (msg.user === their own Slack id). Used to exclude self-authored messages from "awaiting your reply" surfaces. */
  fromSelf?: boolean;
  /** True when this message is from a channel the user is a member of, or a DM/Group DM they're in. Non-member channels are filtered out at fetch time, so emitted messages are member-relevant. */
  isMember?: boolean;
}

// ── User name cache ──
const userNameCache = new Map<string, string>();

async function resolveUserName(web: WebClient, userId: string): Promise<string> {
  if (userNameCache.has(userId)) return userNameCache.get(userId)!;
  try {
    const info = await web.users.info({ user: userId });
    const name = info.user?.real_name || info.user?.name || userId;
    userNameCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

function cleanSlackText(text: string): string {
  if (!text) return "";
  // 1) Resolve @-mentions to cached display names FIRST, so a cache hit yields
  //    "@Real Name" rather than the raw "@U07ABC" that renderSlackText falls back to.
  let t = text.replace(/<@(\w+)>/g, (_m, uid) => `@${userNameCache.get(uid) || uid}`);
  // 2) Resolve Slack special tags via the shared renderer (single source of truth):
  //    <!date^…|fallback> → "Friday, June 26, 2026", <!here/channel/everyone>,
  //    <@U…|display> → "@display", <#C…|name> → "name", <url|label> → "label".
  //    This is what fixes the raw "*Today*-<!date^…>" markup leaking into the UI.
  t = renderSlackText(t);
  // 3) Strip mrkdwn emphasis markers that would otherwise render literally.
  t = t
    .replace(/\*([^*\n]+)\*/g, "$1")                         // *bold*
    .replace(/~([^~\n]+)~/g, "$1")                           // ~strike~
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?])/g, "$1$2") // _italic_ (guards snake_case)
    .replace(/`([^`\n]+)`/g, "$1");                          // `code`
  // 4) Decode the entities Slack escapes, then collapse whitespace.
  return t
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/** The authenticated Slack user's own id (U0…) for the active token, or undefined. */
async function resolveSelfUserId(web: WebClient): Promise<string | undefined> {
  try {
    const auth = await web.auth.test();
    return auth.user_id as string | undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when RAW Slack message text @-mentions the given user (the `<@U0…>` token).
 * Must run on raw text BEFORE cleanSlackText() rewrites `<@U0…>` to `@Name`.
 * Matching the Slack id (not the app username) is what makes mention detection
 * correct and per-user — no hardcoded identity.
 */
function mentionsSelf(rawText: string | undefined, selfUserId: string | undefined): boolean {
  return !!selfUserId && !!rawText && rawText.includes(`<@${selfUserId}>`);
}

// ── In-memory cache so we don't hammer Slack on every page load ──
type CacheEntry = { data: SlackMessage[]; fetchedAt: number };
const messageCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000; // 60s

/** True for a Slack Web API 429 rate-limit rejection (rejectRateLimitedCalls: true). */
function isRateLimited(err: unknown): boolean {
  const e = err as { code?: string; statusCode?: number; data?: { error?: string } } | null;
  return e?.code === "slack_webapi_rate_limited"
    || e?.statusCode === 429
    || e?.data?.error === "ratelimited";
}

// ── What counts as a message ──

/**
 * Calendar apps post agendas and event updates into Slack ("*Today* – Friday…",
 * "Event starting in 10 minutes"). The calendar is already a source of its own,
 * and these are never a person talking to you — they filled the Slack views.
 */
const CALENDAR_APP = /\b(google|outlook|microsoft) calendar\b/i;

export function isCalendarAppPost(m: { username?: string; bot_profile?: { name?: string } | null }): boolean {
  return CALENDAR_APP.test(m.bot_profile?.name ?? "") || CALENDAR_APP.test(m.username ?? "");
}

/** Subtypes that are still a person's message (a file with a comment, a thread reply sent to the channel). */
const PERSON_SUBTYPES = new Set(["file_share", "thread_broadcast", "me_message"]);

type SlackApiMessage = {
  ts?: string; text?: string; user?: string; username?: string; subtype?: string;
  bot_profile?: { name?: string } | null;
};

/** Exported for tests. */
export function isPersonMessage(msg: SlackApiMessage): boolean {
  if (!msg.text) return false;
  if (msg.subtype && !PERSON_SUBTYPES.has(msg.subtype)) return false;
  return !isCalendarAppPost(msg);
}

// ── Which conversations ──

type Convo = { id: string; kind: "channel" | "im" | "mpim"; name?: string; user?: string };

const MAX_CONVERSATIONS = 40;
const HISTORY_PER_CONVERSATION = 30;

/**
 * Every conversation the user is in — every page, not the first. Until
 * 2026-10-10 this read one page per type (30 channels, 20 DMs, 10 group DMs)
 * and kept 15 / 20 / 5 of them, in Slack's arbitrary order: with 26 DMs and 25
 * group DMs, most group DMs never appeared at all.
 */
async function listMemberConversations(web: WebClient): Promise<Map<string, Convo>> {
  const all = async (types: string) => {
    const out: Array<{ id?: string; name?: string; user?: string; is_member?: boolean }> = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const res = await web.conversations.list({ types, limit: 200, exclude_archived: true, cursor });
      out.push(...(res.channels ?? []));
      cursor = res.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    return out;
  };
  const [channels, ims, mpims] = await Promise.all([
    all("public_channel,private_channel"),
    all("im").catch(() => []),
    all("mpim").catch(() => []),
  ]);
  const convos = new Map<string, Convo>();
  // RELEVANCE: channels only when the user is a member — this is what stops
  // signals leaking from channels they never joined. DMs / group DMs are theirs.
  for (const c of channels.filter((c) => !!c.id && c.is_member === true)) convos.set(c.id!, { id: c.id!, kind: "channel", name: c.name });
  for (const c of ims) if (c.id) convos.set(c.id, { id: c.id, kind: "im", user: c.user });
  for (const c of mpims) if (c.id) convos.set(c.id, { id: c.id, kind: "mpim", name: c.name });
  return convos;
}

type SearchHit = { channelId: string; ts: string; user?: string; username?: string; text: string };

/**
 * Everything said in the window, newest first, via search — one call per 100
 * messages instead of one per conversation, and it includes thread replies,
 * which conversations.history never returns. Null when search is unavailable,
 * so the caller reads conversations directly instead.
 */
async function searchRecent(web: WebClient, cutoffMs: number): Promise<SearchHit[] | null> {
  // after: excludes the named day, so ask from the day before the cutoff.
  const after = new Date(cutoffMs - 86_400_000).toISOString().slice(0, 10);
  const hits: SearchHit[] = [];
  try {
    for (let page = 1; page <= 5; page++) {
      const res = await web.search.messages({ query: `after:${after}`, sort: "timestamp", sort_dir: "desc", count: 100, page });
      const matches = (res.messages?.matches ?? []) as Array<SearchHit & { channel?: { id?: string } }>;
      for (const m of matches) {
        if (m.channel?.id && m.ts) hits.push({ channelId: m.channel.id, ts: m.ts, user: m.user, username: m.username, text: m.text ?? "" });
      }
      const last = matches[matches.length - 1]?.ts;
      if (page >= (res.messages?.paging?.pages ?? 1) || (last && parseFloat(last) * 1000 < cutoffMs)) break;
    }
    return hits;
  } catch (err) {
    if (isRateLimited(err)) throw err;
    console.warn("[slack] search unavailable — reading conversations directly:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Read recent messages across all conversation types ──
// Every conversation the user is in; the ones with activity in the window are
// read in full (history + thread replies from search). Filters out messages
// older than `maxAgeDays`.
export async function getRecentSlackMessages(
  username:   string,
  limit      = 10,
  maxAgeDays = 7
): Promise<SlackMessage[]> {
  const [botWeb, userWeb] = await Promise.all([
    getSlackBotClientForUser(username),
    getSlackUserClientForUser(username),
  ]);
  const web = userWeb || botWeb;
  if (!web) return [];

  const cacheKey = `${username}:${limit}:${maxAgeDays}`;
  const cached = messageCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const cutoff = Date.now() - maxAgeDays * 86400000;

  try {
    const lookupWeb = botWeb || web;
    const [convos, selfUserId] = await Promise.all([listMemberConversations(web), resolveSelfUserId(web)]);

    // Search needs the user's own token (a bot cannot search).
    const hits = userWeb ? await searchRecent(userWeb, cutoff) : null;
    const hitsByConvo = new Map<string, SearchHit[]>();
    for (const h of hits ?? []) {
      if (!convos.has(h.channelId) || parseFloat(h.ts) * 1000 < cutoff) continue;
      hitsByConvo.set(h.channelId, [...(hitsByConvo.get(h.channelId) ?? []), h]);
    }

    // Conversations to read: with search, the ones active in the window, most
    // recent first; without it, every conversation with channels and DMs both
    // represented.
    let active: Convo[];
    if (hits) {
      active = [...hitsByConvo.entries()]
        .sort((a, b) => Math.max(...b[1].map((h) => parseFloat(h.ts))) - Math.max(...a[1].map((h) => parseFloat(h.ts))))
        .map(([id]) => convos.get(id)!);
    } else {
      const all = [...convos.values()];
      active = [
        ...all.filter((c) => c.kind === "channel").slice(0, 15),
        ...all.filter((c) => c.kind === "im").slice(0, 20),
        ...all.filter((c) => c.kind === "mpim").slice(0, 10),
      ];
    }

    const messages: SlackMessage[] = [];

    for (const convo of active.slice(0, MAX_CONVERSATIONS)) {
      let channelName = convo.name ? `#${convo.name}` : "DM";
      let channelMembers: string[] | undefined;
      if (convo.kind === "im" && convo.user) {
        const other = await resolveUserName(lookupWeb, convo.user);
        // A DM with a calendar app is the app's daily agenda, not a conversation.
        if (CALENDAR_APP.test(other)) continue;
        channelName = `DM: ${other}`;
        channelMembers = [other.split(" ")[0].toLowerCase()];
      }
      if (convo.kind === "mpim") {
        channelName = "Group DM";
        try {
          // Your token first (you are in every one of your group DMs; the bot
          // usually isn't), the bot's if yours lacks mpim:read.
          const listMembers = (client: typeof lookupWeb) =>
            client.conversations.members({ channel: convo.id, limit: 20 });
          const membersRes = userWeb
            ? await listMembers(userWeb).catch(() => listMembers(lookupWeb))
            : await listMembers(lookupWeb);
          const ids = (membersRes.members || []).filter((id) => id && id !== selfUserId);
          const names = await Promise.all(ids.map((id) => resolveUserName(lookupWeb, id)));
          channelMembers = names.map((n) => n.split(" ")[0].toLowerCase());
          if (channelMembers.length > 0) {
            channelName = `Group DM: ${channelMembers
              .map((n) => n.charAt(0).toUpperCase() + n.slice(1))
              .join(", ")}`;
          }
        } catch {
          /* fall back to generic "Group DM" */
        }
      }

      // The conversation's messages: its history (authoritative and current —
      // search can lag a few minutes) plus search's hits (thread replies, and
      // the only way into private channels this token cannot read history for).
      const raw: SlackApiMessage[] = [];
      try {
        const history = await web.conversations.history({
          channel: convo.id,
          limit: HISTORY_PER_CONVERSATION,
          oldest: String(cutoff / 1000),
        });
        raw.push(...((history.messages || []) as SlackApiMessage[]));
      } catch (err) {
        // A 429 means TRUNCATED data: fail the whole fetch (or serve the complete
        // stale cache) rather than record a partial poll as a quiet inbox.
        if (isRateLimited(err)) throw err;
        /* no history access (e.g. a private channel) — search's hits stand alone */
      }
      const seenTs = new Set(raw.map((m) => m.ts));
      for (const h of hitsByConvo.get(convo.id) ?? []) if (!seenTs.has(h.ts)) raw.push(h);

      for (const msg of raw) {
        if (!isPersonMessage(msg)) continue;
        const msgTime = msg.ts ? parseFloat(msg.ts) * 1000 : 0;
        if (msgTime < cutoff) continue;

        const authorName = msg.user
          ? await resolveUserName(lookupWeb, msg.user)
          : msg.username || "Unknown";

        messages.push({
          id: msg.ts || String(Date.now()),
          channel: channelName,
          channelId: convo.id,
          channelMembers,
          author: authorName,
          text: cleanSlackText(msg.text || ""),
          date: new Date(msgTime).toISOString(),
          isMention: mentionsSelf(msg.text, selfUserId),
          fromSelf: !!selfUserId && msg.user === selfUserId,
          isMember: true,
        });
      }
    }

    const result = messages
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, limit);
    messageCache.set(cacheKey, { data: result, fetchedAt: Date.now() });
    return result;
  } catch (e) {
    // A COMPLETE stale cache beats truncated/empty data.
    if (cached) return cached.data;
    // No cache to fall back on: a rate-limit is a real failure, so REJECT — the
    // caller's track() / health panel then shows "connected but failing" instead
    // of recording a misleadingly-empty inbox as a successful poll.
    if (isRateLimited(e)) throw e;
    console.error("Slack messages error:", e instanceof Error ? e.message : e);
    return [];
  }
}

// ── Read last N messages from a specific channel/conversation ──
// Used by the click-to-expand UI on pinned Slack rows.
export async function getChannelHistory(
  username:  string,
  channelId: string,
  limit =    10
): Promise<SlackMessage[]> {
  const [botWeb, userWeb] = await Promise.all([
    getSlackBotClientForUser(username),
    getSlackUserClientForUser(username),
  ]);
  const web = userWeb || botWeb;
  if (!web) return [];
  const lookupWeb = botWeb || web;
  const selfUserId = await resolveSelfUserId(web);

  try {
    // Resolve channel metadata for display name
    let channelName = "DM";
    try {
      const info = await lookupWeb.conversations.info({ channel: channelId });
      const ch = info.channel as {
        name?: string;
        is_im?: boolean;
        is_mpim?: boolean;
        user?: string;
      } | undefined;
      if (ch?.name) channelName = `#${ch.name}`;
      else if (ch?.is_im && ch.user) {
        channelName = `DM: ${await resolveUserName(lookupWeb, ch.user)}`;
      } else if (ch?.is_mpim) {
        channelName = "Group DM";
      }
    } catch {
      /* ignore, fall back to "DM" */
    }

    const history = await web.conversations.history({
      channel: channelId,
      limit,
    });

    const out: SlackMessage[] = [];
    for (const msg of history.messages || []) {
      if (!isPersonMessage(msg as SlackApiMessage)) continue;
      const authorName = msg.user
        ? await resolveUserName(lookupWeb, msg.user)
        : "Unknown";
      out.push({
        id: msg.ts || String(Date.now()),
        channel: channelName,
        channelId,
        author: authorName,
        text: cleanSlackText(msg.text || ""),
        date: msg.ts
          ? new Date(parseFloat(msg.ts) * 1000).toISOString()
          : new Date().toISOString(),
        isMention: mentionsSelf(msg.text, selfUserId),
      });
    }
    return out;
  } catch (e) {
    console.error("Slack channel history error:", e instanceof Error ? e.message : e);
    return [];
  }
}

// ── Full search (user token has search:read, bot has search:read.*) ──
export async function searchSlackMessages(
  username: string,
  query:    string,
  limit =   10
): Promise<SlackMessage[]> {
  const [botWeb, userWeb] = await Promise.all([
    getSlackBotClientForUser(username),
    getSlackUserClientForUser(username),
  ]);
  // Try user token first (search:read), then bot (search:read.*)
  const searchWeb = userWeb || botWeb;
  if (!searchWeb) return [];
  const selfUserId = await resolveSelfUserId(searchWeb);

  try {
    const res = await searchWeb.search.messages({ query, count: limit, sort: "timestamp", sort_dir: "desc" });

    return (res.messages?.matches || []).map((m) => ({
      id: m.ts || String(Date.now()),
      channel: m.channel?.name ? `#${m.channel.name}` : "DM",
      author: m.username || "Unknown",
      text: cleanSlackText(m.text || ""),
      date: m.ts ? new Date(parseFloat(m.ts) * 1000).toISOString() : new Date().toISOString(),
      isMention: mentionsSelf(m.text, selfUserId),
    }));
  } catch (e) {
    console.error("Slack search error:", e);
    return getRecentSlackMessages(username, limit);
  }
}

// ── Send message ──────────────────────────────────────────────────────────────
//
// Sender selection:
//   1. Prefer the USER token (xoxp-) so the message appears to come from the
//      authenticated user themselves. Recipient sees Michael's name + avatar
//      in their DM list / channel, not "Sage Bot".
//   2. Fall back to the BOT token (xoxb-) only when:
//        - The user token doesn't exist (older installs)
//        - Posting fails as the user (e.g. they're not a member of a public
//          channel — bot has `chat:write.public` so it can still post)
//
// Lookups (channels / users) use the bot when available because it usually has
// broader directory visibility.
export async function sendSlackMessage(
  username: string,
  channel:  string,
  text:     string
): Promise<{ ok: boolean; error?: string }> {
  const userClient = await getSlackUserClientForUser(username);
  const botClient  = await getSlackBotClientForUser(username);
  const primary    = userClient ?? botClient;
  if (!primary) return { ok: false, error: "Slack not connected" };

  const lookupClient = botClient ?? userClient!;

  try {
    const channelName = channel.replace("#", "").trim();

    // Try to find channel by name
    const channelsRes = await lookupClient.conversations.list({
      types: "public_channel,private_channel",
      limit: 200,
    });
    const ch = channelsRes.channels?.find((c) => c.name === channelName);

    if (ch?.id) {
      try {
        await primary.chat.postMessage({ channel: ch.id, text });
        return { ok: true };
      } catch (err) {
        // User token can't post in channels they're not a member of. Bot has
        // `chat:write.public` so it can still post — but it'll appear as the bot.
        if (botClient && primary !== botClient) {
          await botClient.chat.postMessage({ channel: ch.id, text });
          return { ok: true };
        }
        throw err;
      }
    }

    // Maybe it's a user name — open a DM
    const usersRes = await lookupClient.users.list({ limit: 200 });
    const user = usersRes.members?.find(
      (u) =>
        u.real_name?.toLowerCase() === channelName.toLowerCase() ||
        u.name?.toLowerCase() === channelName.toLowerCase()
    );

    if (user?.id) {
      // Open the DM as the user so the conversation lives in *their* DM list
      // with their identity. Posting as the user keeps the same identity.
      const opener = userClient ?? botClient!;
      const dm = await opener.conversations.open({ users: user.id });
      if (dm.channel?.id) {
        await primary.chat.postMessage({ channel: dm.channel.id, text });
        return { ok: true };
      }
    }

    return { ok: false, error: `Could not find channel or user "${channel}"` };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ── Send DM to a specific user — also user-token-first ──────────────────────
//
// Same identity rule as sendSlackMessage: opening and posting via the user
// token (xoxp-) makes the DM appear AS the user — recipient sees Michael's
// avatar, not a bot. Falls back to the bot only when there's no user token.
export async function sendSlackDM(
  username: string,
  userId:   string,
  text:     string
): Promise<{ ok: boolean; error?: string }> {
  const userClient = await getSlackUserClientForUser(username);
  const botClient  = await getSlackBotClientForUser(username);
  const web = userClient ?? botClient;
  if (!web) return { ok: false, error: "Slack not connected" };

  try {
    const dm = await web.conversations.open({ users: userId });
    if (!dm.channel?.id) return { ok: false, error: "Could not open DM" };
    await web.chat.postMessage({ channel: dm.channel.id, text });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ── Look up user profiles ──
export async function getUserProfile(
  username:     string,
  nameOrEmail:  string
): Promise<{
  name: string;
  email?: string;
  title?: string;
  status?: string;
  tz?: string;
} | null> {
  const web = await getSlackBotClientForUser(username);
  if (!web) return null;

  try {
    // Try email lookup first
    if (nameOrEmail.includes("@")) {
      const res = await web.users.lookupByEmail({ email: nameOrEmail });
      if (res.user) {
        return {
          name: res.user.real_name || res.user.name || "",
          email: res.user.profile?.email,
          title: res.user.profile?.title,
          status: res.user.profile?.status_text,
          tz: res.user.tz,
        };
      }
    }

    // Fall back to name search
    const usersRes = await web.users.list({ limit: 200 });
    const user = usersRes.members?.find(
      (u) => u.real_name?.toLowerCase().includes(nameOrEmail.toLowerCase())
    );
    if (user) {
      return {
        name: user.real_name || user.name || "",
        email: user.profile?.email,
        title: user.profile?.title,
        status: user.profile?.status_text,
        tz: user.tz,
      };
    }
    return null;
  } catch {
    return null;
  }
}
