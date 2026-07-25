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
 */
export async function searchOutlookMessages(
  username:    string,
  query?:      string,
  maxResults = 10,
  maxAgeDays?: number
): Promise<OutlookMessage[]> {
  const params = new URLSearchParams({
    $top:     String(maxResults),
    $select:  LIST_SELECT,
    $orderby: "receivedDateTime desc",
  });

  if (query && query.trim()) {
    // $search and $filter cannot be combined — use $search only
    params.set("$search", `"${query.trim()}"`);
    params.delete("$orderby"); // $orderby not supported with $search
  } else {
    const effectiveDays = maxAgeDays ?? 2;
    params.set("$filter", `receivedDateTime ge '${toGraphDateFilter(effectiveDays)}'`);
  }

  const path = `/me/mailFolders/inbox/messages?${params}`;

  try {
    const data = await graphGet<GraphListResponse<GraphMessage>>(username, path);
    if (!data) return [];
    return (data.value || []).map(mapMessage);
  } catch (err) {
    console.error("[outlook-mail] searchOutlookMessages error:", err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Fetch the full body of a specific message.
 * Returns EmailBody (same shape as getEmailBody in gmail.ts).
 */
export async function getOutlookMessageBody(username: string, messageId: string): Promise<EmailBody> {
  const select = "id,subject,from,toRecipients,receivedDateTime,body";
  const data = await graphGet<GraphMessage>(username, `/me/messages/${messageId}?$select=${select}`);
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
      toRecipients: [{ emailAddress: { address: to } }],
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
        toRecipients: [{ emailAddress: { address: to } }],
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
