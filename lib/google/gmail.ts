import { google } from "googleapis";
import { getAuthedClient } from "./auth";

export interface GmailMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  date: string;
  unread: boolean;
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
  return searchEmails(username, "in:inbox", maxResults, maxAgeDays);
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
      metadataHeaders: ["From", "To", "Subject", "Date"],
    });

    const headers = detail.data.payload?.headers || [];
    const getHeader = (name: string) => headers.find((h) => h.name === name)?.value || "";

    // Extract just the display name from "Name <email>" format
    function extractName(raw: string): string {
      const m = raw.match(/^"?([^"<]+)"?\s*</);
      return m ? m[1].trim() : raw.split("@")[0];
    }

    const fromRaw = getHeader("From");
    const toRaw = getHeader("To");

    messages.push({
      id: msg.id,
      from: extractName(fromRaw),
      to: toRaw,
      subject: getHeader("Subject"),
      snippet: detail.data.snippet || "",
      date: new Date(parseInt(detail.data.internalDate || "0")).toISOString(),
      unread: (detail.data.labelIds || []).includes("UNREAD"),
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

export async function createDraft(username: string, to: string, subject: string, body: string): Promise<{ id: string }> {
  const auth = await getAuthedClient(username);
  if (!auth) throw new Error("Gmail not connected");

  const gmail = google.gmail({ version: "v1", auth });

  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
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
  body: string
): Promise<{ id: string }> {
  const auth = await getAuthedClient(username);
  if (!auth) throw new Error("Gmail not connected");

  const gmail = google.gmail({ version: "v1", auth });

  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
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
