import { WebClient, LogLevel } from "@slack/web-api";
import { getIntegrationToken, saveIntegrationToken, deleteIntegrationToken } from "@/lib/storage/secure-token-store";

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

  // Fall back to env-var tokens when no stored OAuth config exists.
  // This lets SLACK_BOT_TOKEN / SLACK_USER_TOKEN work without a full OAuth flow.
  const botToken   = stored?.botToken   ?? process.env.SLACK_BOT_TOKEN;
  const userToken  = stored?.userToken  ?? process.env.SLACK_USER_TOKEN;

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
  return text
    .replace(/<@(\w+)>/g, (_, uid) => `@${userNameCache.get(uid) || uid}`)
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .substring(0, 300);
}

// ── In-memory cache so we don't hammer Slack on every page load ──
type CacheEntry = { data: SlackMessage[]; fetchedAt: number };
const messageCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000; // 60s

// ── Read recent messages across all conversation types ──
// Fetches channels AND DMs separately to ensure DMs aren't crowded out.
// Filters out messages older than `maxAgeDays` to keep results fresh.
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
    const hasUserToken = !!userWeb;
    const lookupWeb = botWeb || web;

    // Fetch channels and DMs in separate calls to ensure both are represented
    const [channelsRes, dmsRes, groupDmsRes] = await Promise.all([
      web.conversations.list({
        types: hasUserToken
          ? "public_channel,private_channel"
          : "public_channel,private_channel",
        limit: 30,
        exclude_archived: true,
      }),
      web.conversations.list({
        types: "im",
        limit: 20,
      }).catch(() => ({ channels: [] })),
      hasUserToken
        ? web.conversations.list({
            types: "mpim",
            limit: 10,
          }).catch(() => ({ channels: [] }))
        : Promise.resolve({ channels: [] }),
    ]);

    // Process channels and DMs with separate caps to guarantee both get slots
    const channelConvos = (channelsRes.channels || []).filter((c) => !!c.id).slice(0, 15);
    const dmConvos = (dmsRes.channels || []).filter((c) => !!c.id).slice(0, 20);
    const groupDmConvos = (groupDmsRes.channels || []).filter((c) => !!c.id).slice(0, 5);

    // Deduplicate across all three
    const seen = new Set<string>();
    const uniqueChannels = [...channelConvos, ...dmConvos, ...groupDmConvos].filter((ch) => {
      if (!ch.id || seen.has(ch.id)) return false;
      seen.add(ch.id);
      return true;
    });

    const messages: SlackMessage[] = [];

    // Resolve self user id once so we can exclude it from member lists
    let selfUserId: string | undefined;
    try {
      const auth = await web.auth.test();
      selfUserId = auth.user_id as string | undefined;
    } catch {
      /* ignore */
    }

    for (const channel of uniqueChannels) {
      if (!channel.id) continue;

      let channelName = channel.name ? `#${channel.name}` : "DM";
      let channelMembers: string[] | undefined;
      if (channel.is_im && channel.user) {
        const other = await resolveUserName(lookupWeb, channel.user);
        channelName = `DM: ${other}`;
        channelMembers = [other.split(" ")[0].toLowerCase()];
      }
      if (channel.is_mpim) {
        channelName = "Group DM";
        try {
          const membersRes = await lookupWeb.conversations.members({
            channel: channel.id,
            limit: 20,
          });
          const ids = (membersRes.members || []).filter(
            (id) => id && id !== selfUserId
          );
          const names = await Promise.all(
            ids.map((id) => resolveUserName(lookupWeb, id))
          );
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

      try {
        // Only fetch messages newer than cutoff (Slack ts = epoch seconds)
        const oldest = String(cutoff / 1000);
        const history = await web.conversations.history({
          channel: channel.id,
          limit: 5,
          oldest,
        });

        for (const msg of history.messages || []) {
          if (!msg.text || msg.subtype) continue;

          const msgTime = msg.ts ? parseFloat(msg.ts) * 1000 : 0;
          if (msgTime < cutoff) continue; // belt-and-suspenders staleness filter

          const authorName = msg.user
            ? await resolveUserName(lookupWeb, msg.user)
            : "Unknown";

          messages.push({
            id: msg.ts || String(Date.now()),
            channel: channelName,
            channelId: channel.id,
            channelMembers,
            author: authorName,
            text: cleanSlackText(msg.text || ""),
            date: msg.ts
              ? new Date(parseFloat(msg.ts) * 1000).toISOString()
              : new Date().toISOString(),
            isMention: (msg.text || "").toLowerCase().includes(username),
          });
        }
      } catch {
        /* skip channels we can't access */
      }
    }

    const result = messages
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, limit);
    messageCache.set(cacheKey, { data: result, fetchedAt: Date.now() });
    return result;
  } catch (e) {
    // If rate-limited, serve any stale cached data instead of returning empty
    if (cached) return cached.data;
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
      if (!msg.text || msg.subtype) continue;
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
        isMention: (msg.text || "").toLowerCase().includes(username),
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

  try {
    const res = await searchWeb.search.messages({ query, count: limit, sort: "timestamp", sort_dir: "desc" });

    return (res.messages?.matches || []).map((m) => ({
      id: m.ts || String(Date.now()),
      channel: m.channel?.name ? `#${m.channel.name}` : "DM",
      author: m.username || "Unknown",
      text: cleanSlackText(m.text || ""),
      date: m.ts ? new Date(parseFloat(m.ts) * 1000).toISOString() : new Date().toISOString(),
      isMention: (m.text || "").toLowerCase().includes(username),
    }));
  } catch (e) {
    console.error("Slack search error:", e);
    return getRecentSlackMessages(username, limit);
  }
}

// ── Send message (bot: chat:write.public works without being in channel) ──
export async function sendSlackMessage(
  username: string,
  channel:  string,
  text:     string
): Promise<{ ok: boolean; error?: string }> {
  const web = await getSlackBotClientForUser(username);
  if (!web) return { ok: false, error: "Slack not connected" };

  try {
    const channelName = channel.replace("#", "").trim();

    // Try to find channel by name
    const channelsRes = await web.conversations.list({ types: "public_channel,private_channel", limit: 200 });
    const ch = channelsRes.channels?.find((c) => c.name === channelName);

    if (ch?.id) {
      // chat:write.public allows posting without being a member
      await web.chat.postMessage({ channel: ch.id, text });
      return { ok: true };
    }

    // Maybe it's a user name — start a DM
    const usersRes = await web.users.list({ limit: 200 });
    const user = usersRes.members?.find(
      (u) =>
        u.real_name?.toLowerCase() === channelName.toLowerCase() ||
        u.name?.toLowerCase() === channelName.toLowerCase()
    );

    if (user?.id) {
      const dm = await web.conversations.open({ users: user.id });
      if (dm.channel?.id) {
        await web.chat.postMessage({ channel: dm.channel.id, text });
        return { ok: true };
      }
    }

    return { ok: false, error: `Could not find channel or user "${channel}"` };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ── Send DM to a specific user ──
export async function sendSlackDM(
  username: string,
  userId:   string,
  text:     string
): Promise<{ ok: boolean; error?: string }> {
  const web = await getSlackBotClientForUser(username);
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
