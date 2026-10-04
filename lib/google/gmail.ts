import { google } from "googleapis";
import { getAuthedClient } from "./auth";

export interface GmailMessage {
  id: string;
  /** Display name of the sender (e.g. "Tom Beardmore"). Use for UI only. */
  from: string;
  /** Raw email address of the sender (e.g. "tom@example.com").
   *  Use this as the To: header when drafting replies. */
  fromEmail: string;
  to: string;
  subject: string;
  snippet: string;
  date: string;
  unread: boolean;
  /** Gmail label ids, e.g. CATEGORY_PROMOTIONS, SENT, INBOX. */
  labels?: string[];
  /** Mailing-list / bulk / auto-generated mail (see isBulkMail). */
  bulk?: boolean;
  cc?: string;
  threadId?: string;
}

/** Headers requested with every metadata fetch — enough to judge bulk mail and addressing. */
const METADATA_HEADERS = ["From", "To", "Cc", "Subject", "Date", "List-Unsubscribe", "List-Id", "Precedence", "Auto-Submitted"];

/**
 * Mail sent to a list rather than to a person: newsletters, marketing, event
 * blasts, review requests, automated notices. Those carry List-Unsubscribe /
 * List-Id (RFC 2369/2919), "Precedence: bulk|list|junk", or Auto-Submitted
 * (RFC 3834). Sender-name heuristics alone missed "Events | BPESA" and
 * "Waitilist | OP Labs", which became "Register for…" and "Leave a review…"
 * on the Action Tracker. Pure — exported for tests.
 */
export function isBulkMail(header: (name: string) => string): boolean {
  if (header("List-Unsubscribe").trim() || header("List-Id").trim()) return true;
  if (/^\s*(bulk|list|junk)\b/i.test(header("Precedence"))) return true;
  const auto = header("Auto-Submitted").trim().toLowerCase();
  return !!auto && auto !== "no";
}

/**
 * Returns the N most recent emails from the last `maxAgeDays` days.
 * Defaults: last 2 days, 10 results — suitable for ingestion polling.
 * Pass `maxAgeDays: 7` for meeting-prep and briefing to widen the window.
 */
export async function getRecentEmails(
  username: string,
  maxResults = 10,
  maxAgeDays = 2
): Promise<GmailMessage[]> {
  // Restrict to inbox only — without this, Gmail returns sent mail too, causing
  // emails FROM the user to be ingested and incorrectly flagged by the rules engine.
  // NOTE: getSentEmails() below is the deliberate counterpart — see its docstring.
  return searchEmails(username, "in:inbox", maxResults, maxAgeDays);
}

/**
 * The user's OWN sent mail.
 *
 * Separate from getRecentEmails on purpose. That function is inbox-only so the
 * user's outbound mail is never ingested as an inbound signal — correct, but it
 * left Basil unable to see the user RESOLVING anything by email. A brief once
 * reported "Kyndryl pricing is sitting on your desk" days after the user had
 * emailed the deck out, because the sending was structurally invisible.
 *
 * Results from here are for RESOLUTION CHECKING ONLY — establishing that the
 * user already acted. They must never be fed to the classifier as new signals,
 * which is what the inbox restriction exists to prevent.
 */
export async function getSentEmails(
  username: string,
  maxResults = 25,
  maxAgeDays = 7
): Promise<GmailMessage[]> {
  return searchEmails(username, "in:sent", maxResults, maxAgeDays);
}

/**
 * Search Gmail. When `query` is omitted, returns the most recent `maxAgeDays` days.
 * When a query is provided, Gmail search operators are honoured (from:, subject:, etc.)
 * and the date window is `maxAgeDays` (default 30 days for searches).
 */
export async function searchEmails(
  username: string,
  query: string | undefined,
  maxResults = 10,
  maxAgeDays?: number
): Promise<GmailMessage[]> {
  const auth = await getAuthedClient(username);
  if (!auth) return [];

  const gmail = google.gmail({ version: "v1", auth });

  // Resolve effective lookback: explicit > query-default (30d) > no-query default (2d)
  const effectiveDays = maxAgeDays ?? (query && query.trim() ? 30 : 2);
  const q = query && query.trim()
    ? `${query.trim()} newer_than:${effectiveDays}d`
    : `newer_than:${effectiveDays}d`;

  const res = await gmail.users.messages.list({
    userId: "me",
    maxResults,
    q,
  });

  const messages: GmailMessage[] = [];

  for (const msg of res.data.messages?.slice(0, maxResults) || []) {
    if (!msg.id) continue;
    const detail = await gmail.users.messages.get({
      userId: "me",
      id: msg.id,
      format: "metadata",
      metadataHeaders: METADATA_HEADERS,
    });

    const headers = detail.data.payload?.headers || [];
    const getHeader = (name: string) => headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";

    // Extract just the display name from "Name <email>" format
    function extractName(raw: string): string {
      const m = raw.match(/^"?([^"<]+)"?\s*</);
      return m ? m[1].trim() : raw.split("@")[0];
    }

    // Extract just the email address from "Name <email>" or bare "email" format
    function extractEmailAddr(raw: string): string {
      const m = raw.match(/<([^>]+@[^>]+)>/);
      if (m) return m[1].trim();
      if (raw.includes("@")) return raw.trim();
      return raw; // fallback: return as-is
    }

    const fromRaw = getHeader("From");
    const toRaw = getHeader("To");

    messages.push({
      id: msg.id,
      from: extractName(fromRaw),
      fromEmail: extractEmailAddr(fromRaw),
      to: toRaw,
      subject: getHeader("Subject"),
      snippet: detail.data.snippet || "",
      date: new Date(parseInt(detail.data.internalDate || "0")).toISOString(),
      unread: (detail.data.labelIds || []).includes("UNREAD"),
      labels: detail.data.labelIds || [],
      bulk: isBulkMail(getHeader),
      cc: getHeader("Cc"),
      threadId: detail.data.threadId || undefined,
    });
  }

  return messages;
}

export interface EmailBody {
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf-8");
}

function extractBody(payload: { mimeType?: string | null; body?: { data?: string | null } | null; parts?: Array<{ mimeType?: string | null; body?: { data?: string | null } | null; parts?: Array<{ mimeType?: string | null; body?: { data?: string | null } | null }> }> | null }): string {
  // Direct body on the payload (non-multipart messages)
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  if (!payload.parts) return "";

  // Look for text/plain first, then text/html
  for (const mimeType of ["text/plain", "text/html"]) {
    for (const part of payload.parts) {
      if (part.mimeType === mimeType && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
      // Handle nested multipart (e.g. multipart/alternative inside multipart/mixed)
      if (part.parts) {
        for (const nested of part.parts) {
          if (nested.mimeType === mimeType && nested.body?.data) {
            return decodeBase64Url(nested.body.data);
          }
        }
      }
    }
  }

  return "";
}

export async function getEmailBody(username: string, messageId: string): Promise<EmailBody> {
  const auth = await getAuthedClient(username);
  if (!auth) throw new Error("Gmail not connected");

  const gmail = google.gmail({ version: "v1", auth });

  const detail = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  const headers = detail.data.payload?.headers || [];
  const getHeader = (name: string) =>
    headers.find((h) => h.name === name)?.value || "";

  const fromRaw = getHeader("From");
  const fromMatch = fromRaw.match(/^"?([^"<]+)"?\s*</);
  const from = fromMatch ? fromMatch[1].trim() : fromRaw;

  const body = detail.data.payload
    ? extractBody(detail.data.payload)
    : "";

  return {
    from,
    to: getHeader("To"),
    subject: getHeader("Subject"),
    date: new Date(
      parseInt(detail.data.internalDate || "0")
    ).toISOString(),
    body: body || detail.data.snippet || "",
  };
}

export async function createDraft(
  username: string,
  to: string,
  subject: string,
  body: string,
  /** Optional send-as From address (a verified Gmail alias). Omit for the primary. */
  from?: string
): Promise<{ id: string }> {
  const auth = await getAuthedClient(username);
  if (!auth) throw new Error("Gmail not connected");

  const gmail = google.gmail({ version: "v1", auth });

  // Strip CR/LF from header values to prevent header injection (esp. the
  // user/alias-controlled `from`). Body keeps its newlines (it follows the blank line).
  const hdr = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
  const safeFrom = from ? hdr(from) : "";
  const fromHeader = safeFrom ? `From: ${safeFrom}\r\n` : "";
  const raw = Buffer.from(
    `${fromHeader}To: ${hdr(to)}\r\nSubject: ${hdr(subject)}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
  ).toString("base64url");

  const res = await gmail.users.drafts.create({
    userId: "me",
    requestBody: { message: { raw } },
  });

  return { id: res.data.id || "" };
}

/**
 * Actually send an email via Gmail.
 * Requires the gmail.send OAuth scope (included in gmail.modify).
 */
export async function sendEmail(
  username: string,
  to: string,
  subject: string,
  body: string,
  /** Optional send-as From address (a verified Gmail alias). Omit for the primary. */
  from?: string
): Promise<{ id: string }> {
  const auth = await getAuthedClient(username);
  if (!auth) throw new Error("Gmail not connected");

  const gmail = google.gmail({ version: "v1", auth });

  // Strip CR/LF from header values to prevent header injection (esp. the
  // user/alias-controlled `from`). Body keeps its newlines (it follows the blank line).
  const hdr = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
  const safeFrom = from ? hdr(from) : "";
  const fromHeader = safeFrom ? `From: ${safeFrom}\r\n` : "";
  const raw = Buffer.from(
    `${fromHeader}To: ${hdr(to)}\r\nSubject: ${hdr(subject)}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
  ).toString("base64url");

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });

  return { id: res.data.id || "" };
}

// ── Reply detection ────────────────────────────────────────────────────────────

export interface SentReplyInfo {
  /** Gmail message ID of the sent reply. */
  messageId: string;
  /** Subject line of the original thread. */
  subject: string;
  /** ISO timestamp when the reply was sent. */
  sentAt: string;
  /** Display name or email of the original sender (who we replied to). */
  originalFrom: string;
}

/**
 * Returns the email address of the authenticated Gmail account (from users.getProfile).
 * This is the canonical address to use for self-sent mail detection — it works regardless
 * of what email is registered in the Basil user record.
 * Returns null if Gmail is not connected or the call fails.
 */
export async function getGmailAddress(username: string): Promise<string | null> {
  try {
    const auth = await getAuthedClient(username);
    if (!auth) return null;
    const gmail = google.gmail({ version: "v1", auth });
    const profile = await gmail.users.getProfile({ userId: "me" });
    return profile.data.emailAddress?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/**
 * Given an original Gmail message ID and the action creation timestamp, checks
 * whether the user sent a reply in that thread AFTER the action was created.
 *
 * Returns the reply info if found, null otherwise.
 * Never throws — errors return null and are logged.
 */
export async function checkThreadForSentReply(
  username: string,
  originalMessageId: string,
  actionCreatedAt: string
): Promise<SentReplyInfo | null> {
  try {
    const auth = await getAuthedClient(username);
    if (!auth) return null;

    const gmail = google.gmail({ version: "v1", auth });

    // 1. Fetch the original message to get threadId + subject + original sender
    const orig = await gmail.users.messages.get({
      userId:          "me",
      id:              originalMessageId,
      format:          "metadata",
      metadataHeaders: ["From", "Subject"],
    });

    const threadId = orig.data.threadId;
    if (!threadId) return null;

    const headers    = orig.data.payload?.headers ?? [];
    const subject    = headers.find((h) => h.name === "Subject")?.value ?? "(no subject)";
    const fromRaw    = headers.find((h) => h.name === "From")?.value ?? "";
    const fromMatch  = fromRaw.match(/^"?([^"<]+)"?\s*</);
    const originalFrom = fromMatch ? fromMatch[1].trim() : fromRaw.split("@")[0];

    const afterMs = new Date(actionCreatedAt).getTime();

    // 2. Fetch all messages in the thread (metadata only — cheap)
    const thread = await gmail.users.threads.get({
      userId: "me",
      id:     threadId,
      format: "metadata",
    });

    for (const msg of thread.data.messages ?? []) {
      if (msg.id === originalMessageId) continue;             // skip the original
      if (!(msg.labelIds ?? []).includes("SENT")) continue;  // only sent messages
      const sentMs = parseInt(msg.internalDate ?? "0", 10);
      if (sentMs <= afterMs) continue;                        // must be AFTER action was created

      return {
        messageId:    msg.id!,
        subject,
        sentAt:       new Date(sentMs).toISOString(),
        originalFrom,
      };
    }

    return null;
  } catch (err) {
    console.error("[gmail] checkThreadForSentReply error:", err);
    return null;
  }
}

export interface ThreadMessage {
  id: string;
  fromName: string;
  fromEmail: string;
  to: string;
  cc: string;
  date: string;
  /** Sent by the mailbox owner. */
  sent: boolean;
  snippet: string;
  labels: string[];
  bulk: boolean;
}

export interface ThreadState {
  threadId: string;
  subject: string;
  original: ThreadMessage;
  /** Messages after the original, oldest first — replies from anyone. */
  later: ThreadMessage[];
}

/**
 * The whole conversation around one message: the message itself and everything
 * after it, from anyone. checkThreadForSentReply only asks "did the user reply?",
 * which cannot see a colleague answering the question on a reply-all — the
 * other half of "is this still waiting on me?". Never throws; null on failure.
 */
export async function getThreadState(username: string, messageId: string): Promise<ThreadState | null> {
  try {
    const auth = await getAuthedClient(username);
    if (!auth) return null;
    const gmail = google.gmail({ version: "v1", auth });
    const orig = await gmail.users.messages.get({ userId: "me", id: messageId, format: "minimal" });
    const threadId = orig.data.threadId;
    if (!threadId) return null;
    const thread = await gmail.users.threads.get({ userId: "me", id: threadId, format: "metadata", metadataHeaders: METADATA_HEADERS });
    const msgs: ThreadMessage[] = (thread.data.messages ?? []).map((m) => {
      const hs = m.payload?.headers ?? [];
      const h = (n: string) => hs.find((x) => x.name?.toLowerCase() === n.toLowerCase())?.value || "";
      const fromRaw = h("From");
      const nameMatch = fromRaw.match(/^"?([^"<]+)"?\s*</);
      const emailMatch = fromRaw.match(/<([^>]+@[^>]+)>/);
      return {
        id: m.id ?? "",
        fromName: nameMatch ? nameMatch[1].trim() : fromRaw.split("@")[0],
        fromEmail: (emailMatch ? emailMatch[1] : fromRaw).trim().toLowerCase(),
        to: h("To"),
        cc: h("Cc"),
        date: new Date(parseInt(m.internalDate ?? "0", 10)).toISOString(),
        sent: (m.labelIds ?? []).includes("SENT"),
        snippet: m.snippet ?? "",
        labels: m.labelIds ?? [],
        bulk: isBulkMail(h),
      };
    });
    const original = msgs.find((m) => m.id === messageId);
    if (!original) return null;
    const subjectHeader = (thread.data.messages ?? []).find((m) => m.id === messageId)?.payload?.headers
      ?.find((x) => x.name?.toLowerCase() === "subject")?.value ?? "(no subject)";
    const later = msgs
      .filter((m) => m.id !== messageId && m.date > original.date)
      .sort((a, b) => a.date.localeCompare(b.date));
    return { threadId, subject: subjectHeader, original, later };
  } catch (err) {
    console.error("[gmail] getThreadState error:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Replying in a thread ───────────────────────────────────────────────────────

export interface Address { name: string; email: string }

/** Split an address header ("A <a@x>, "B, C" <b@x>, c@x") into addresses. Pure. */
export function parseAddressList(header: string): Address[] {
  const out: Address[] = [];
  let cur = "", quoted = false, angle = false;
  const flush = () => {
    const part = cur.trim(); cur = "";
    if (!part) return;
    const m = part.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
    const email = (m ? m[2] : part).trim().replace(/^mailto:/i, "");
    if (!email.includes("@")) return;
    out.push({ name: m ? m[1].trim() : "", email: email.toLowerCase() });
  };
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    if (ch === "<") angle = true;
    if (ch === ">") angle = false;
    if (ch === "," && !quoted && !angle) { flush(); continue; }
    cur += ch;
  }
  flush();
  return out;
}

export interface ReplyContext {
  messageId: string;
  threadId: string;
  subject: string;
  date: string;
  from: Address;
  /** Original To / Cc, as sent. */
  to: Address[];
  cc: Address[];
  /** Where a plain reply goes (Reply-To, else From; the original To when you wrote it). */
  replyTo: Address[];
  /** Extra Cc for reply-all — everyone else on the message, never you. */
  replyAllCc: Address[];
  /** RFC 5322 Message-ID and References — what threads the reply in every client. */
  rfcMessageId: string;
  references: string;
  body: string;
  selfEmails: string[];
}

/** Pure — exported for tests. */
export function replyRecipients(
  h: { from: Address; replyToHeader: Address[]; to: Address[]; cc: Address[] },
  selfEmails: readonly string[],
): { replyTo: Address[]; replyAllCc: Address[] } {
  const self = new Set(selfEmails.map((e) => e.toLowerCase()));
  const fromSelf = self.has(h.from.email);
  const replyTo = fromSelf ? h.to : (h.replyToHeader.length ? h.replyToHeader : [h.from]);
  const taken = new Set(replyTo.map((a) => a.email));
  const replyAllCc: Address[] = [];
  for (const a of [...h.to, ...h.cc]) {
    if (self.has(a.email) || taken.has(a.email)) continue;
    taken.add(a.email);
    replyAllCc.push(a);
  }
  return { replyTo: replyTo.filter((a) => !self.has(a.email)), replyAllCc };
}

export async function getReplyContext(username: string, messageId: string): Promise<ReplyContext> {
  const auth = await getAuthedClient(username);
  if (!auth) throw new Error("Gmail not connected");
  const gmail = google.gmail({ version: "v1", auth });
  const [detail, selfAddress] = await Promise.all([
    gmail.users.messages.get({ userId: "me", id: messageId, format: "full" }),
    getGmailAddress(username),
  ]);
  const headers = detail.data.payload?.headers ?? [];
  const h = (n: string) => headers.find((x) => x.name?.toLowerCase() === n.toLowerCase())?.value || "";
  const from = parseAddressList(h("From"))[0] ?? { name: "", email: "" };
  const to = parseAddressList(h("To"));
  const cc = parseAddressList(h("Cc"));
  const selfEmails = [selfAddress?.toLowerCase()].filter((e): e is string => !!e);
  const { replyTo, replyAllCc } = replyRecipients({ from, replyToHeader: parseAddressList(h("Reply-To")), to, cc }, selfEmails);
  return {
    messageId,
    threadId: detail.data.threadId || "",
    subject: h("Subject"),
    date: new Date(parseInt(detail.data.internalDate || "0", 10)).toISOString(),
    from, to, cc, replyTo, replyAllCc,
    rfcMessageId: h("Message-ID") || h("Message-Id"),
    references: h("References"),
    body: (detail.data.payload ? extractBody(detail.data.payload) : "") || detail.data.snippet || "",
    selfEmails,
  };
}

const fmtAddress = (a: Address) => a.name ? `"${a.name.replace(/["\\\r\n]/g, "")}" <${a.email}>` : a.email;
/** RFC 2047 for non-ASCII header text (subjects in other languages, em dashes). */
const encodeHeader = (s: string) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
const headerSafe = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

/**
 * The reply as a raw RFC 5322 message. In-Reply-To + References + the Gmail
 * threadId are what make it a reply rather than a new email — without them the
 * recipient gets a separate conversation. Pure — exported for tests.
 */
export function buildReplyMime(ctx: ReplyContext, body: string, opts: { replyAll?: boolean } = {}): { raw: string; to: Address[]; cc: Address[] } {
  const to = ctx.replyTo;
  const cc = opts.replyAll ? ctx.replyAllCc : [];
  if (to.length === 0) throw new Error("No one to reply to on this message.");
  const subject = /^\s*re:/i.test(ctx.subject) ? ctx.subject : `Re: ${ctx.subject || "(no subject)"}`;
  const refs = [ctx.references, ctx.rfcMessageId].filter(Boolean).join(" ").trim();
  const when = new Date(ctx.date).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London" });
  const quoted = ctx.body.trim().slice(0, 3_000).split(/\r?\n/).map((l) => `> ${l}`).join("\n");
  const text = `${body.trim()}\n\nOn ${when}, ${fmtAddress(ctx.from)} wrote:\n${quoted}\n`;
  const lines = [
    `To: ${headerSafe(to.map(fmtAddress).join(", "))}`,
    ...(cc.length ? [`Cc: ${headerSafe(cc.map(fmtAddress).join(", "))}`] : []),
    `Subject: ${encodeHeader(headerSafe(subject))}`,
    ...(ctx.rfcMessageId ? [`In-Reply-To: ${headerSafe(ctx.rfcMessageId)}`] : []),
    ...(refs ? [`References: ${headerSafe(refs)}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
  ];
  return { raw: Buffer.from(`${lines.join("\r\n")}\r\n\r\n${text}`, "utf8").toString("base64url"), to, cc };
}

/** Send a reply in the original Gmail thread. */
export async function replyToEmail(
  username: string,
  messageId: string,
  body: string,
  opts: { replyAll?: boolean } = {},
): Promise<{ id: string; threadId: string; to: Address[]; cc: Address[] }> {
  if (!body.trim()) throw new Error("The reply is empty.");
  const ctx = await getReplyContext(username, messageId);
  const { raw, to, cc } = buildReplyMime(ctx, body, opts);
  const auth = await getAuthedClient(username);
  if (!auth) throw new Error("Gmail not connected");
  const gmail = google.gmail({ version: "v1", auth });
  const res = await gmail.users.messages.send({ userId: "me", requestBody: { raw, threadId: ctx.threadId || undefined } });
  return { id: res.data.id || "", threadId: res.data.threadId || ctx.threadId, to, cc };
}
