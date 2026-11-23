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

import { getRecentEmails, getGmailAddress, getThreadState, getSentEmails, getEmailBody, type GmailMessage, type ThreadState } from "@/lib/google/gmail";
import { loadKnownSenders } from "@/lib/email/known-senders";
import { getEventsForDateRange, type CalendarEvent } from "@/lib/google/calendar";
import { findAnsweringCalendarEvent, type InviteCalendarEvent } from "@/lib/followups/invitation-rsvp";
import { getSlackUserClientForUser, isSlackConnected } from "@/lib/slack/client";
import { isGoogleConnected } from "@/lib/google/auth";
import { getSelfIdentity, isSelf } from "@/lib/self-identity";
import type { PendingFollowup, DetectFollowupsResult } from "@/lib/followups/types";
import { filterNoReplyNeeded, type ReplyCandidate } from "@/lib/email/needs-reply";
import {
  latestMessageText, touchesFromSent, touchesFromEvents, touchesFromSlackDm, touchSignature,
  slackDirectory, type SlackDirectory, type SlackLike, type Touch,
} from "@/lib/followups/context";
import { decodeEntities } from "@/lib/email/view-cache";

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

// Booking / scheduling confirmations. Sent by a person's booking page (Microsoft
// Bookings, Calendly, …) so the sender looks human and the subject is just the
// meeting title — "MICHAEL COOK - 2. Research interview with Lusher Advisory"
// sat on Today as "Reply to Carter Lusher" for days. Matched on the body.
const BOOKING_CONFIRMATION_HINTS: RegExp[] = [
  /\bscheduled from the bookings? page\b/i,
  /\breschedule or cancel (this|your) (meeting|appointment|booking|event)\b/i,
  /\ba new event has been scheduled\b/i,
  /\b(this|your) (meeting|appointment|booking|event) (has been|was|is) (scheduled|booked|confirmed)\b/i,
  /\bbooking (is )?confirmed\b/i,
];

/** True when the body reads as an automatic booking/scheduling confirmation. Exported for tests. */
export function isBookingConfirmation(text: string): boolean {
  return BOOKING_CONFIRMATION_HINTS.some((p) => p.test(text || ""));
}

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

/** Never throws: a helper that is missing or fails yields the fallback. */
async function safely<T>(f: () => Promise<T>, fallback: T, what: string): Promise<T> {
  try {
    return await f();
  } catch (e) {
    console.warn(`[followups] ${what} unavailable:`, e instanceof Error ? e.message : e);
    return fallback;
  }
}

/**
 * Read once per detection and shared by the Gmail and Slack passes: the user's
 * sent mail, the calendar around now and the Slack directory. They let the
 * needs-reply judge see a card answered by ANOTHER route (a fresh email, a Slack
 * DM, a meeting booked with the sender) — not only a reply in the same thread.
 */
interface Shared {
  sent: Promise<GmailMessage[]>;
  events: Promise<CalendarEvent[]>;
  slack: Promise<{ web: SlackLike; selfId: string; dir: SlackDirectory | null } | null>;
}

function loadShared(username: string, maxAgeDays: number): Shared {
  const memo = <T>(f: () => Promise<T>) => { let p: Promise<T> | undefined; return () => (p ??= f()); };
  const sent = memo(() => safely(() => getSentEmails(username, 40, maxAgeDays), [] as GmailMessage[], "sent mail"));
  const events = memo(() => loadRsvpEvents(username) as Promise<CalendarEvent[]>);
  const slack = memo(() => safely(async () => {
    const web = await getSlackUserClientForUser(username);
    if (!web) return null;
    const auth = await web.auth.test() as { user_id?: string };
    if (!auth.user_id) return null;
    const client = web as unknown as SlackLike;
    return { web: client, selfId: auth.user_id, dir: await slackDirectory(client) };
  }, null, "Slack directory"));
  return {
    get sent() { return sent(); },
    get events() { return events(); },
    get slack() { return slack(); },
  };
}

/** Everything the user did with this person after `sinceIso`, newest first. */
async function touchesWith(shared: Shared, email: string | undefined, sinceIso: string, opts: { slack?: boolean } = {}): Promise<Touch[]> {
  if (!email) return [];
  const [sent, events, slack] = await Promise.all([shared.sent, shared.events, opts.slack === false ? null : shared.slack]);
  const dm = slack ? await touchesFromSlackDm(slack.web, slack.selfId, slack.dir, email, sinceIso) : [];
  return [...touchesFromSent(sent, email, sinceIso), ...dm, ...touchesFromEvents(events, email, sinceIso)]
    .sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * Calendar events around now, for invitation-RSVP suppression.
 *
 * Window spans backwards as well as forwards: an invitation email can still be
 * sitting unanswered-looking in the inbox after the meeting has happened, and
 * that is exactly the case that nags loudest. Never throws — an unavailable
 * calendar must not take the whole follow-up list down with it.
 */
async function loadRsvpEvents(username: string): Promise<InviteCalendarEvent[]> {
  const day = (offsetDays: number) =>
    new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
  try {
    return await getEventsForDateRange(username, day(-30), day(60));
  } catch (err) {
    console.warn(
      "[followups] calendar RSVP lookup failed — not suppressing answered invitations:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

async function detectGmail(
  username: string,
  cutoff: number,
  maxAgeDays: number,
  shared: Shared = loadShared(username, maxAgeDays),
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

  const [inbound, known] = await Promise.all([
    getRecentEmails(username, 50, maxAgeDays),
    loadKnownSenders(username),
  ]);
  const addressed = inbound.filter((m) => {
    if (new Date(m.date).getTime() >= cutoff) return false;
    if (isAutomatedSender(m.from, m.fromEmail, m.subject)) return false;
    if (isBookingConfirmation(m.snippet || "")) return false;
    // List / marketing mail, by its own headers or Gmail's tabs — unless a
    // known correspondent sent it. Nobody is waiting on a reply to a blast.
    const promo = (m.labels ?? []).some((l) => l === "CATEGORY_PROMOTIONS" || l === "CATEGORY_SOCIAL");
    if ((m.bulk || promo) && !known.isKnown(m.fromEmail)) return false;
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

  // One card per CONVERSATION, anchored on its newest message addressed to the
  // user. Per-message cards kept asking for a reply to an early message after a
  // colleague had answered it on a reply-all.
  const newestPerThread = new Map<string, (typeof addressed)[number]>();
  for (const m of addressed) {
    const key = m.threadId ?? m.id;
    const prev = newestPerThread.get(key);
    if (!prev || m.date > prev.date) newestPerThread.set(key, m);
  }
  const candidates = [...newestPerThread.values()];

  // Calendar RSVP state, so an invitation the user ANSWERED on the calendar
  // stops being reported as awaiting a reply. checkThreadForSentReply below can
  // never see this: accepting an invite sends no message into the Gmail thread,
  // so without this an accepted meeting nags forever and climbs the ranking as
  // it ages. Best-effort — if calendar is unavailable we simply don't suppress
  // (showing an extra card is far better than hiding a real request).
  const rsvpEvents = await shared.events;

  const threads = new Map<string, ThreadState>();
  const results = await mapLimit(candidates, GMAIL_CONCURRENCY, async (m) => {
    const answered = rsvpEvents.length
      ? findAnsweringCalendarEvent(
          { subject: m.subject, snippet: m.snippet, from: m.from },
          rsvpEvents,
        )
      : null;
    if (answered) {
      // Logged, not silent: a suppression rule that misfires would hide real
      // mail, and that must be diagnosable from the logs alone.
      console.log(
        `[followups] suppressed "${(m.subject || "").slice(0, 60)}" — invitation already ` +
        `${answered.myResponseStatus} on the calendar ("${answered.summary}")`
      );
      return null;
    }

    // Awaiting only while this is still the last word in the conversation: a
    // later message from the user means they replied; a later message from
    // anyone else means the thread moved on without needing them (if it DID
    // ask them, that newer message is its own candidate above).
    const thread = await getThreadState(username, m.id);
    if (thread && thread.later.length > 0) return null;
    if (thread) threads.set(m.id, thread);
    const followup: PendingFollowup = {
      id: `gmail:${m.id}`,
      source: "gmail",
      fromName: m.from,
      fromEmail: m.fromEmail,
      subject: m.subject || "(no subject)",
      preview: decodeEntities(m.snippet || "").slice(0, PREVIEW_LEN),
      lastInboundAt: m.date,
      hoursWaiting: hoursSince(m.date),
      // Opens inside Basil (the threads page expands it in place), never Gmail.
      href: `/dashboard/threads?open=${encodeURIComponent(`gmail:${m.id}`)}`,
    };
    return followup;
  });

  const awaiting = results.filter((r): r is PendingFollowup => r !== null);

  // Still the last word, from a person, addressed to you — but does it ask
  // anything of YOU, and has it not been answered some other way? The judge
  // reads the whole message (a ~140-character preview is not enough to tell
  // "Anja, can we meet?" from "Michael, can we meet?"), who it went to, the
  // earlier thread, and what the user has done with the sender since.
  const firstName = identity.names[0]?.trim().split(/\s+/)[0] || "the user";
  const judged: ReplyCandidate[] = await mapLimit(awaiting, GMAIL_CONCURRENCY, async (f) => {
    const id = f.id.replace(/^gmail:/, "");
    const m = candidates.find((c) => c.id === id);
    const thread = threads.get(id);
    const body = await safely(() => getEmailBody(username, id).then((b) => latestMessageText(b.body || "")), "", "email body");
    const since = await touchesWith(shared, f.fromEmail, f.lastInboundAt);
    return {
      id, channel: "email" as const, from: f.fromName, subject: f.subject, at: f.lastInboundAt,
      text: body || (m?.snippet ? decodeEntities(m.snippet) : f.preview),
      to: m?.to, cc: m?.cc,
      earlier: (thread?.earlier ?? []).map((e) => ({ from: e.fromName || e.fromEmail, at: e.date, text: decodeEntities(e.snippet) })),
      since, sinceSig: touchSignature(since),
    };
  });
  const noReply = await filterNoReplyNeeded(username, firstName, judged, undefined, { selfEmails: [...selfEmails] }).catch((e) => {
    console.warn("[followups] needs-reply check failed, keeping every card:", e instanceof Error ? e.message : e);
    return new Map<string, { reason: string }>();
  });
  for (const [id, v] of noReply) {
    const f = awaiting.find((x) => x.id === `gmail:${id}`);
    console.log(`[followups] suppressed "${(f?.subject || "").slice(0, 60)}" — no reply needed (${v.reason})`);
  }

  return { items: awaiting.filter((f) => !noReply.has(f.id.replace(/^gmail:/, ""))), connected: true };
}

async function detectSlack(
  username: string,
  cutoff: number,
  shared?: Shared,
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
  let channels: Array<{ id?: string; is_mpim?: boolean }> = [];
  // In a group DM the last word is often a colleague answering someone else —
  // that only waits on the user when it names them.
  const selfFirstNames = (await getSelfIdentity(username)).names
    .map((n) => n.trim().split(/\s+/)[0]?.toLowerCase() ?? "")
    .filter((n) => n.length > 2);
  try {
    const list = await web.conversations.list({ types: "im,mpim", limit: 50 });
    channels = (list.channels as Array<{ id?: string; is_mpim?: boolean }>) ?? [];
  } catch {
    return { items: [], connected: true };
  }

  const items: PendingFollowup[] = [];
  const judged: ReplyCandidate[] = [];
  const directory = shared ? (await shared.slack)?.dir ?? null : null;
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
      if (c.is_mpim) {
        const text = (last.text ?? "").toLowerCase();
        const mentioned = text.includes(`<@${selfId.toLowerCase()}>`)
          || selfFirstNames.some((n) => new RegExp(`\\b${n}\\b`).test(text));
        if (!mentioned) continue;
      }

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

      // For the judge: the conversation before it, and what the user has done
      // with this person since by email or in a meeting. Keyed by message, not
      // channel, so a new message in the same DM is judged afresh.
      const at = new Date(lastMs).toISOString();
      const email = last.user ? directory?.emailById.get(last.user) : undefined;
      const since = shared ? await touchesWith(shared, email, at, { slack: false }) : [];
      const earlier = msgs
        .filter((m) => m !== last && !m.subtype && m.text && m.ts && parseFloat(m.ts) * 1000 < lastMs)
        .slice(0, 4).reverse()
        .map((m) => ({ from: m.user === selfId ? "You" : fromName, at: new Date(parseFloat(m.ts as string) * 1000).toISOString(), text: cleanSlackText(m.text ?? "") }));
      judged.push({
        id: `slack:${c.id}:${last.ts}`, channel: "slack", from: fromName, subject: "", at,
        text: cleanSlackText(last.text ?? ""), earlier, since, sinceSig: touchSignature(since),
      });

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

  // The same check as email: does it ask the user anything, and is it still open?
  const firstName = (await getSelfIdentity(username)).names[0]?.trim().split(/\s+/)[0] || "the user";
  const noReply = judged.length
    ? await filterNoReplyNeeded(username, firstName, judged).catch((e) => {
      console.warn("[followups] Slack needs-reply check failed, keeping every card:", e instanceof Error ? e.message : e);
      return new Map<string, { reason: string }>();
    })
    : new Map<string, { reason: string }>();
  const dropped = new Set([...noReply.keys()].map((k) => k.split(":").slice(0, 2).join(":")));
  for (const [id, v] of noReply) console.log(`[followups] suppressed Slack ${id.split(":")[1]} — no reply needed (${v.reason})`);
  return { items: items.filter((i) => !dropped.has(i.id)), connected: true };
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
  // The failure is reported by NAME, and connectivity is looked up rather than
  // assumed false — a broken Gmail is still a connected Gmail.
  const degraded: string[] = [];
  const shared = loadShared(username, maxAgeDays);
  const [gmail, slack] = await Promise.all([
    detectGmail(username, cutoff, maxAgeDays, shared).catch(async (err) => {
      console.warn("[followups] gmail detection failed:", err instanceof Error ? err.message : err);
      degraded.push("Gmail");
      return { items: [], connected: await isGoogleConnected(username).catch(() => false) };
    }),
    detectSlack(username, cutoff, shared).catch(async (err) => {
      console.warn("[followups] slack detection failed:", err instanceof Error ? err.message : err);
      degraded.push("Slack");
      return { items: [], connected: await isSlackConnected(username).catch(() => false) };
    }),
  ]);

  const items = [...gmail.items, ...slack.items].sort((a, b) => b.hoursWaiting - a.hoursWaiting);

  const result: DetectFollowupsResult = {
    items,
    sources: { gmail: gmail.connected, slack: slack.connected },
    ...(degraded.length > 0 ? { degraded } : {}),
  };
  // NEVER cache a degraded result. Previously a single Gmail 429 or expired
  // token produced `{items: []}` which was then served for the full 90s TTL —
  // so the home screen confidently reported "nothing awaiting reply", which is
  // indistinguishable from a genuinely quiet inbox. Skipping the write means
  // the very next request retries instead of trusting a known-bad empty.
  if (degraded.length === 0) followupCache.set(cacheKey, { data: result, at: Date.now() });
  return result;
}
