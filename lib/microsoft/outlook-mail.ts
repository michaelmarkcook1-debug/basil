/**
 * Microsoft Graph Outlook mail functions.
 *
 * Mirrors the shape and behaviour of lib/google/gmail.ts — same interface
 * field names, same function signatures, same error-handling conventions.
 * Uses raw fetch via graphGet/graphFetch (no external SDK).
 */

import { graphGet, graphFetch } from "./auth";
import type { EmailBody } from "@/lib/google/gmail";

// ── Types ────────────────────────────────────────────────────────────────────

export interface OutlookMessage {
  id:        string;
  from:      string;    // display name, extracted from from.emailAddress.name
  fromEmail: string;    // raw sender address — needed for self-filter + junk triage
  to:        string;    // first toRecipient email address
  subject:   string;
  snippet:   string;    // bodyPreview
  date:      string;    // ISO, from receivedDateTime
  unread:    boolean;   // !isRead
}

// ── Graph response shapes (internal) ─────────────────────────────────────────

interface GraphRecipient {
  emailAddress: { name: string; address: string };
}

interface GraphMessage {
  id:                  string;
  subject:             string;
  from:                GraphRecipient;
  toRecipients:        GraphRecipient[];
  receivedDateTime:    string;
  isRead:              boolean;
  bodyPreview:         string;
  body?:               { contentType: string; content: string };
}

interface GraphListResponse<T> {
  value: T[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const LIST_SELECT =
  "id,subject,from,toRecipients,receivedDateTime,isRead,bodyPreview";

function mapMessage(m: GraphMessage): OutlookMessage {
  return {
    id:        m.id,
    from:      m.from?.emailAddress?.name || m.from?.emailAddress?.address || "",
    fromEmail: m.from?.emailAddress?.address || "",
    to:        m.toRecipients?.[0]?.emailAddress?.address || "",
    subject:   m.subject || "",
    snippet:   m.bodyPreview || "",
    date:      m.receivedDateTime || "",
    unread:    !m.isRead,
  };
}

/** Outlook ingestion stores message ids as "outlook:<graph id>". */
export function isOutlookMessageId(id: string): boolean {
  return typeof id === "string" && id.startsWith("outlook:");
}

export function rawOutlookMessageId(id: string): string {
  return isOutlookMessageId(id) ? id.slice("outlook:".length) : id;
}

/**
 * "a@x.io, Ann Lee <ann@y.io>" → Graph recipients. Sending the whole string
 * as one address (before 2026-11-10) made Graph reject any multi-recipient
 * email. Pure — exported for tests.
 */
export function toRecipients(to: string): Array<{ emailAddress: { address: string; name?: string } }> {
  return to
    .split(/[,;](?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const m = part.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
      return m
        ? { emailAddress: { address: m[2].trim(), ...(m[1].trim() ? { name: m[1].trim() } : {}) } }
        : { emailAddress: { address: part } };
    });
}

function toGraphDateFilter(ageDays: number): string {
  const d = new Date(Date.now() - ageDays * 86400000);
  // Format: YYYY-MM-DDTHH:MM:SSZ
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the N most recent inbox messages from the last `maxAgeDays` days.
 * Defaults: last 2 days, 10 results — suitable for ingestion polling.
 */
export async function getRecentOutlookMessages(
  username:   string,
  maxResults = 10,
  maxAgeDays = 2
): Promise<OutlookMessage[]> {
  return searchOutlookMessages(username, undefined, maxResults, maxAgeDays);
}

/**
 * Search Outlook inbox messages.
 * When `query` is provided, uses $search (OData v4 KQL) — cannot be combined
 * with $filter, so the date window is dropped when a query is present.
 * When no query is given, $filter by receivedDateTime is applied.
 * Returns [] on any error (ingestion polling); Ask Basil uses
 * queryOutlookMessages, which reports the failure instead.
 */
export async function searchOutlookMessages(
  username:    string,
  query?:      string,
  maxResults = 10,
  maxAgeDays?: number
): Promise<OutlookMessage[]> {
  try {
    return (await queryOutlookMessages(username, query, { maxResults, maxAgeDays, folder: "inbox" })) ?? [];
  } catch (err) {
    console.error("[outlook-mail] searchOutlookMessages error:", err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Search Outlook mail. Null when Microsoft is not connected; THROWS on a Graph
 * error so a failed search is never reported as "no messages".
 * `folder: "all"` searches every folder (like Gmail search), "inbox" the inbox.
 */
export async function queryOutlookMessages(
  username: string,
  query: string | undefined,
  opts: { maxResults?: number; maxAgeDays?: number; folder?: "inbox" | "all" } = {},
): Promise<OutlookMessage[] | null> {
  const params = new URLSearchParams({
    $top:     String(opts.maxResults ?? 10),
    $select:  LIST_SELECT,
    $orderby: "receivedDateTime desc",
  });

  if (query && query.trim()) {
    // $search and $filter cannot be combined — use $search only
    params.set("$search", `"${query.trim().replace(/"/g, "")}"`);
    params.delete("$orderby"); // $orderby not supported with $search
  } else {
    const effectiveDays = opts.maxAgeDays ?? 2;
    params.set("$filter", `receivedDateTime ge '${toGraphDateFilter(effectiveDays)}'`);
  }

  const base = opts.folder === "all" ? "/me/messages" : "/me/mailFolders/inbox/messages";
  const data = await graphGet<GraphListResponse<GraphMessage>>(username, `${base}?${params}`);
  if (!data) return null;
  return (data.value || []).map(mapMessage);
}

/**
 * Fetch the full body of a specific message.
 * Returns EmailBody (same shape as getEmailBody in gmail.ts). `text: true`
 * asks Graph for plain text instead of the HTML body.
 */
export async function getOutlookMessageBody(username: string, messageId: string, opts: { text?: boolean } = {}): Promise<EmailBody> {
  const select = "id,subject,from,toRecipients,receivedDateTime,body";
  const path = `/me/messages/${encodeURIComponent(rawOutlookMessageId(messageId))}?$select=${select}`;
  let data: GraphMessage | null;
  if (opts.text) {
    const res = await graphFetch(username, path, { method: "GET", headers: { Prefer: 'outlook.body-content-type="text"' } });
    if (!res) throw new Error("Microsoft not connected");
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Graph GET message → HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    data = await res.json() as GraphMessage;
  } else {
    data = await graphGet<GraphMessage>(username, path);
  }
  if (!data) throw new Error("Microsoft not connected");

  return {
    from:    data.from?.emailAddress?.name || data.from?.emailAddress?.address || "",
    to:      data.toRecipients?.[0]?.emailAddress?.address || "",
    subject: data.subject || "",
    date:    data.receivedDateTime || "",
    body:    data.body?.content || "",
  };
}

/**
 * Create a draft message in the user's mailbox.
 * Returns the Graph-assigned message id.
 */
export async function createOutlookDraft(
  username: string,
  to:       string,
  subject:  string,
  body:     string
): Promise<{ id: string }> {
  const res = await graphFetch(username, "/me/messages", {
    method: "POST",
    body:   JSON.stringify({
      subject,
      body:         { contentType: "Text", content: body },
      toRecipients: toRecipients(to),
    }),
  });

  if (!res) throw new Error("Microsoft not connected");
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`createOutlookDraft HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json() as { id: string };
  return { id: data.id };
}

/**
 * Send an email via Graph /me/sendMail.
 * Graph returns 202 with no body for this endpoint, so a synthetic id is
 * generated from the current timestamp.
 */
export async function sendOutlookEmail(
  username: string,
  to:       string,
  subject:  string,
  body:     string
): Promise<{ id: string }> {
  const res = await graphFetch(username, "/me/sendMail", {
    method: "POST",
    body:   JSON.stringify({
      message: {
        subject,
        body:         { contentType: "Text", content: body },
        toRecipients: toRecipients(to),
      },
      saveToSentItems: true,
    }),
  });

  if (!res) throw new Error("Microsoft not connected");
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`sendOutlookEmail HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  // 202 Accepted — no body from Graph
  return { id: `outlook:${Date.now()}` };
}

export interface OutlookAddress { name: string; email: string }

/**
 * Reply to an Outlook message in its own conversation (Graph reply /
 * replyAll; Outlook quotes the original). Returns who it went to, read from
 * the message before sending. Accepts "outlook:<id>" or the bare Graph id.
 */
export async function replyToOutlookMessage(
  username: string,
  messageId: string,
  body: string,
  opts: { replyAll?: boolean; selfEmails?: string[] } = {},
): Promise<{ id: string; threadId: string; to: OutlookAddress[]; cc: OutlookAddress[] }> {
  if (!body.trim()) throw new Error("The reply is empty.");
  const id = encodeURIComponent(rawOutlookMessageId(messageId));
  const msg = await graphGet<{
    conversationId?: string;
    from?: GraphRecipient;
    replyTo?: GraphRecipient[];
    toRecipients?: GraphRecipient[];
    ccRecipients?: GraphRecipient[];
  }>(username, `/me/messages/${id}?$select=id,conversationId,from,replyTo,toRecipients,ccRecipients`);
  if (!msg) throw new Error("Microsoft not connected");

  const addr = (r: GraphRecipient): OutlookAddress => ({ name: r.emailAddress?.name || "", email: (r.emailAddress?.address || "").toLowerCase() });
  const self = new Set((opts.selfEmails ?? []).map((s) => s.toLowerCase()));
  const sender = (msg.replyTo?.length ? msg.replyTo : msg.from ? [msg.from] : []).map(addr).filter((a) => a.email);
  const others = opts.replyAll ? (msg.toRecipients ?? []).map(addr) : [];
  const seen = new Set<string>();
  const keep = (a: OutlookAddress) => !!a.email && !self.has(a.email) && !seen.has(a.email) && !!seen.add(a.email);
  const to = [...sender, ...others].filter(keep);
  const cc = opts.replyAll ? (msg.ccRecipients ?? []).map(addr).filter(keep) : [];

  const res = await graphFetch(username, `/me/messages/${id}/${opts.replyAll ? "replyAll" : "reply"}`, {
    method: "POST",
    body: JSON.stringify({ comment: body }),
  });
  if (!res) throw new Error("Microsoft not connected");
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`replyToOutlookMessage HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return { id: `outlook:reply:${Date.now()}`, threadId: msg.conversationId || "", to, cc };
}
