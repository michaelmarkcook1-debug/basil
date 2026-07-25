/**
 * lib/followups/detect.ts
 *
 * Detects threads/DMs awaiting the user's reply: last message inbound (from
 * someone else), older than `staleHours`, with no outbound since.
 *
 *  • Gmail — getRecentEmails forces `in:inbox`. Note this does NOT exclude mail
 *    you send to yourself (it still carries the INBOX label), so detectGmail
 *    applies an explicit self-identity filter (registered email + aliases + your
 *    display name). checkThreadForSentReply does the inverse test (did the user
 *    SEND anything after this message?) — null return means "no reply yet" ⇒
 *    awaiting. Contentless mail (empty snippet) and automated senders are dropped.
 *  • Slack — direction is NOT on SlackMessage (author is a display name, not the
 *    user id), so we read raw conversations.history and compare msg.user to the
 *    active token's own user id. Requires a USER token (xoxp-) for trustworthy
 *    direction; with only a bot token we skip Slack (the human never sends as the
 *    bot, so every message would look "inbound").
 *
 * Every fetcher returns [] (never throws) when the integration is unconnected, so
 * an empty result is disambiguated by the `sources` flags, not by length.
 */

import { getRecentEmails, getGmailAddress, checkThreadForSentReply } from "@/lib/google/gmail";
import { getSlackUserClientForUser } from "@/lib/slack/client";
import { getSelfIdentity, isSelf } from "@/lib/self-identity";
import type { PendingFollowup, DetectFollowupsResult } from "@/lib/followups/types";

const DEFAULT_MAX_AGE_DAYS = 7;
const DEFAULT_STALE_HOURS = 24;
const PREVIEW_LEN = 140;
// Bound concurrent Gmail thread lookups so a large inbox doesn't fan out into
// hundreds of simultaneous API calls (each checkThreadForSentReply is 1-2 calls).
const GMAIL_CONCURRENCY = 6;

function hoursSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
}

// Local-parts that signal an automated/no-reply/marketing sender — you don't
// "reply" to these. Matched as a substring of the address local-part.
const AUTOMATED_LOCALPARTS = [
  "noreply", "no-reply", "donotreply", "do-not-reply", "no_reply",
  "notification", "notifications", "notify", "alerts", "alert",
  "mailer", "mailer-daemon", "bounce", "postmaster", "automated", "auto",
  "newsletter", "news", "updates", "update", "marketing", "promo", "promotions",
  "info", "hello", "team", "support", "help", "contact", "billing", "invoice",
  "receipts", "receipt", "account", "accounts", "security", "verify",
  "verification", "otp", "confirm", "confirmations", "digest", "feed",
  "calendar-notification", "calendar", "invite", "invites", "reminders",
];

// Domains that are essentially always transactional/marketing for our purposes.
const AUTOMATED_DOMAINS = [
  "zoom.us", "eventbrite.com", "calendly.com", "mailchimp", "sendgrid",
  "substack.com", "intercom", "hubspot", "salesforce", "docusign",
  "linear.app", "google.com", "calendar.google.com", "github.com", "slack.com",
  "atlassian.net", "notion.so", "asana.com",
  // Meeting-notes / AI assistant bots — they send recaps, you never reply to them.
  "read.ai", "otter.ai", "fireflies.ai", "fathom.video", "grain.com", "tldv.io",
];

const AUTOMATED_SUBJECT_HINTS = [
  "verification code", "one-time", "one time pass", "otp", "passcode",
  "has joined", "are ready", "is ready", "unsubscribe", "do not share",
  "your code", "sign-in", "sign in code", "confirm your", "verify your",
  "receipt", "invoice", "newsletter",
  // Calendar invite / RSVP notifications — never a "reply".
  "invitation:", "accepted:", "declined:", "tentative:", "updated invitation",
  "canceled:", "cancelled:", "new invitation", "rsvp", "this event has been",
];

/**
 * True when an inbound email is from an automated/no-reply/newsletter sender —
 * i.e. replying makes no sense. Keeps the awaiting-reply feed to mail from real
 * people. Conservative: only filters clear machine senders, not ambiguous ones.
 */
function isAutomatedSender(from: string, fromEmail: string, subject: string): boolean {
  const email = (fromEmail || "").toLowerCase();
  const local = email.split("@")[0] ?? "";
  const domain = email.split("@")[1] ?? "";
  const name = (from || "").toLowerCase();
  const subj = (subject || "").toLowerCase();

  if (AUTOMATED_LOCALPARTS.some((kw) => local.includes(kw))) return true;
  if (AUTOMATED_DOMAINS.some((d) => domain.includes(d))) return true;
  // Display-name tells (e.g. "The Rundown AI", "... Newsletter", "... Team",
  // "Read Assistant" / meeting-recap bots).
  if (/newsletter|no.?reply|notifications?|updates|digest|team\b|assistant|meeting (notes|recap)|recap\b/.test(name)) return true;
  if (AUTOMATED_SUBJECT_HINTS.some((h) => subj.includes(h))) return true;
  return false;
}

/** Minimal Slack markup stripper — turns <@U123>, <#C1|name>, <url|text> readable. */
function cleanSlackText(raw: string): string {
  return (raw || "")
    .replace(/<@[A-Z0-9]+>/g, "@someone")
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Run an async mapper over items with a fixed concurrency ceiling. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function detectGmail(
  username: string,
  cutoff: number,
  maxAgeDays: number
): Promise<{ items: PendingFollowup[]; connected: boolean }> {
  // Connection check is authoritative (empty inbox != disconnected).
  const address = await getGmailAddress(username);
  if (!address) return { items: [], connected: false };

  // Self-identity: the user's registered email + name + the live mailbox address.
  // `in:inbox` does NOT exclude mail you send to yourself (it carries the INBOX
  // label), so without this guard a self-sent message surfaces as "Reply to
  // <your own name>". isSelf() also matches the display name, so mail sent from
  // an alias address (e.g. michael@…​.com) is still caught via the "Michael Cook"
  // name even when the address differs from the registered one.
  const identity = await getSelfIdentity(username);
  const selfEmails = new Set<string>([...identity.emails, address.toLowerCase()]);

  // First names for the Cc-escape hatch below ("Michael, can you…" in a thread
  // where he's only Cc'd still deserves a card).
  const selfFirstNames = identity.names
    .map((n) => n.trim().split(/\s+/)[0]?.toLowerCase() ?? "")
    .filter((n) => n.length > 2);

  const inbound = await getRecentEmails(username, 50, maxAgeDays);
  const candidates = inbound.filter((m) => {
    if (new Date(m.date).getTime() >= cutoff) return false;
    if (isAutomatedSender(m.from, m.fromEmail, m.subject)) return false;
    // Never tell the user to reply to themselves.
    if (selfEmails.has((m.fromEmail || "").toLowerCase())) return false;
    if (isSelf(m.fromEmail, identity) || isSelf(m.from, identity)) return false;
    // Drop contentless mail (e.g. a blank "Test") — there is nothing to reply to.
    if ((m.snippet || "").trim().length === 0) return false;

    // Only ask the user to reply to mail actually ADDRESSED to them. Inbox
    // membership isn't enough: being Cc'd on someone else's thread produced
    // "Reply to Ed Baum" cards for invitations that opened "Hi Rohan…" and for
    // prospects thanking Ed — the user was neither in To nor named. Rule: a
    // self address must appear in the To header; when it doesn't (Cc, list
    // mail, undisclosed recipients), keep the card ONLY if the visible text
    // calls the user out by first name.
    const toLower = (m.to || "").toLowerCase();
    const inTo = [...selfEmails].some((e) => e && toLower.includes(e));
    if (!inTo) {
      const snip = (m.snippet || "").toLowerCase();
      if (!selfFirstNames.some((n) => snip.includes(n))) return false;
    }
    return true;
  });

  const results = await mapLimit(candidates, GMAIL_CONCURRENCY, async (m) => {
    const reply = await checkThreadForSentReply(username, m.id, m.date);
    if (reply !== null) return null; // user already replied in this thread
    const followup: PendingFollowup = {
      id: `gmail:${m.id}`,
      source: "gmail",
      fromName: m.from,
      fromEmail: m.fromEmail,
      subject: m.subject || "(no subject)",
      preview: (m.snippet || "").slice(0, PREVIEW_LEN),
      lastInboundAt: m.date,
      hoursWaiting: hoursSince(m.date),
      href: `https://mail.google.com/mail/u/0/#inbox/${m.id}`,
    };
    return followup;
  });

  return { items: results.filter((r): r is PendingFollowup => r !== null), connected: true };
}

async function detectSlack(
  username: string,
  cutoff: number
): Promise<{ items: PendingFollowup[]; connected: boolean }> {
  // Only a USER token gives trustworthy direction. No user client ⇒ skip Slack.
  const web = await getSlackUserClientForUser(username);
  if (!web) return { items: [], connected: false };

  // Resolve own user id (the "[You]" identity) and the workspace id (for deep links).
  let selfId: string | undefined;
  let teamId: string | undefined;
  try {
    const auth = await web.auth.test() as { user_id?: string; team_id?: string };
    selfId = auth.user_id;
    teamId = auth.team_id;
  } catch {
    return { items: [], connected: false };
  }
  if (!selfId) return { items: [], connected: false };

  // Enumerate DMs + Group DMs.
  let channels: Array<{ id?: string }> = [];
  try {
    const list = await web.conversations.list({ types: "im,mpim", limit: 50 });
    channels = (list.channels as Array<{ id?: string }>) ?? [];
  } catch {
    return { items: [], connected: true };
  }

  const items: PendingFollowup[] = [];
  for (const c of channels) {
    if (!c.id) continue;
    try {
      const hist = await web.conversations.history({ channel: c.id, limit: 10 });
      const msgs = (hist.messages as Array<{ user?: string; text?: string; ts?: string; subtype?: string }>) ?? [];
      // Newest real message (skip joins/edits/file-shares + empty text).
      const last = msgs.find((m) => !m.subtype && m.text && m.text.trim().length > 0);
      if (!last || !last.ts) continue;
      const lastMs = parseFloat(last.ts) * 1000;
      // Awaiting iff the newest message is inbound (not from us) AND stale.
      if (last.user === selfId) continue;
      if (lastMs >= cutoff) continue;

      let fromName = "";
      if (last.user) {
        try {
          const info = await web.users.info({ user: last.user });
          const u = (info as { user?: { real_name?: string; name?: string; is_bot?: boolean } }).user;
          if (u?.is_bot) continue; // skip bot DMs entirely
          fromName = u?.real_name || u?.name || "";
        } catch {
          fromName = "";
        }
      }
      // Skip if the name never resolved (would render "Reply to U054EFB8E10").
      if (!fromName || /^U[A-Z0-9]{6,}$/.test(fromName)) continue;

      // Message-anchored link: opens the exact message, not just the top of the
      // conversation. One extra call per SURFACED follow-up only (a handful, not
      // per-channel-scanned) — best-effort, falls back to the conversation link.
      let href = teamId && c.id ? `https://app.slack.com/client/${teamId}/${c.id}` : "/dashboard/chat";
      try {
        const perma = await web.chat.getPermalink({ channel: c.id, message_ts: last.ts });
        if (perma.permalink) href = perma.permalink;
      } catch {
        // Fall back to the conversation-level link already set above.
      }

      items.push({
        id: `slack:${c.id}`,
        source: "slack",
        fromName,
        subject: `DM with ${fromName}`,
        preview: cleanSlackText(last.text ?? "").slice(0, PREVIEW_LEN),
        lastInboundAt: new Date(lastMs).toISOString(),
        hoursWaiting: Math.floor((Date.now() - lastMs) / 3_600_000),
        // Deep-link to the actual Slack DM (opens the conversation to reply) —
        // NOT /dashboard/chat, which was a dead affordance: the card's hover
        // promised "open the Slack thread" and instead landed on empty Ask Basil.
        href,
      });
    } catch {
      // Per-channel failure is non-fatal — skip and continue.
      continue;
    }
  }

  return { items, connected: true };
}

/**
 * detectPendingFollowups — the public entry point.
 *
 * Gmail and Slack are detected independently and fault-isolated: a failure in
 * one source yields connected:false / [] for that source without sinking the
 * other. Results are merged and sorted by hoursWaiting DESC (longest-waiting
 * first).
 */
// Short-TTL per-user cache. detectGmail + detectSlack fan out into ~150 Gmail
// thread checks + Slack history calls; the home page (/api/today) reads this on
// every load, so without a cache each visit re-runs the whole fan-out. In-memory
// (per warm serverless instance) — a cold start simply recomputes. TTL is short
// enough that "awaiting reply" stays actionable.
type FollowupCacheEntry = { data: DetectFollowupsResult; at: number };
const followupCache = new Map<string, FollowupCacheEntry>();
const FOLLOWUP_TTL_MS = 90_000; // 90s

export async function detectPendingFollowups(
  username: string,
  opts?: { maxAgeDays?: number; staleHours?: number }
): Promise<DetectFollowupsResult> {
  const maxAgeDays = opts?.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const staleHours = opts?.staleHours ?? DEFAULT_STALE_HOURS;

  const cacheKey = `${username}:${maxAgeDays}:${staleHours}`;
  const cached = followupCache.get(cacheKey);
  if (cached && Date.now() - cached.at < FOLLOWUP_TTL_MS) return cached.data;

  const cutoff = Date.now() - staleHours * 3_600_000;

  // Track failures separately from "connected: false". A source that THREW has
  // an UNKNOWN answer; a source that returned zero items genuinely has none.
  let degraded = false;
  const [gmail, slack] = await Promise.all([
    detectGmail(username, cutoff, maxAgeDays).catch((err) => {
      console.warn("[followups] gmail detection failed:", err instanceof Error ? err.message : err);
      degraded = true;
      return { items: [], connected: false };
    }),
    detectSlack(username, cutoff).catch((err) => {
      console.warn("[followups] slack detection failed:", err instanceof Error ? err.message : err);
      degraded = true;
      return { items: [], connected: false };
    }),
  ]);

  const items = [...gmail.items, ...slack.items].sort((a, b) => b.hoursWaiting - a.hoursWaiting);

  const result: DetectFollowupsResult = { items, sources: { gmail: gmail.connected, slack: slack.connected } };
  // NEVER cache a degraded result. Previously a single Gmail 429 or expired
  // token produced `{items: []}` which was then served for the full 90s TTL —
  // so the home screen confidently reported "nothing awaiting reply", which is
  // indistinguishable from a genuinely quiet inbox. Skipping the write means
  // the very next request retries instead of trusting a known-bad empty.
  if (!degraded) followupCache.set(cacheKey, { data: result, at: Date.now() });
  return result;
}
