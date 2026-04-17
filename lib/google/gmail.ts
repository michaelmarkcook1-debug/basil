import { google } from "googleapis";
import { getAuthedClient } from "./auth";

export interface GmailMessage {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  date: string;
  unread: boolean;
}

export async function getRecentEmails(maxResults = 10): Promise<GmailMessage[]> {
  return searchEmails(undefined, maxResults);
}

/**
 * Search Gmail. When `query` is omitted, returns the most recent 2 days.
 * When provided, Gmail search operators are honoured (from:, subject:, etc.)
 * and we broaden the date window to 30 days so older matches surface.
 */
export async function searchEmails(
  query: string | undefined,
  maxResults = 10
): Promise<GmailMessage[]> {
  const auth = getAuthedClient();
  if (!auth) return [];

  const gmail = google.gmail({ version: "v1", auth });

  const q = query && query.trim()
    ? `${query.trim()} newer_than:30d`
    : "newer_than:2d";

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
      metadataHeaders: ["From", "Subject", "Date"],
    });

    const headers = detail.data.payload?.headers || [];
    const getHeader = (name: string) => headers.find((h) => h.name === name)?.value || "";

    // Extract just the name from "Name <email>" format
    const fromRaw = getHeader("From");
    const fromMatch = fromRaw.match(/^"?([^"<]+)"?\s*</);
    const from = fromMatch ? fromMatch[1].trim() : fromRaw.split("@")[0];

    messages.push({
      id: msg.id,
      from,
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

export async function getEmailBody(messageId: string): Promise<EmailBody> {
  const auth = getAuthedClient();
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

export async function createDraft(to: string, subject: string, body: string): Promise<{ id: string }> {
  const auth = getAuthedClient();
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
