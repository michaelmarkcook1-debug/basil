/**
 * lib/mail/unified.ts — recent inbox and sent mail across Gmail and Outlook
 * (audit 2026-11-24, Part 3 entry 8: Microsoft parity).
 *
 * Ask Basil already searched both mailboxes; the briefing, meeting prep and
 * weekly digest read Gmail only, so a Microsoft 365 user's mail was missing
 * from all three. These merge both, newest first, in the GmailMessage shape
 * (Outlook ids are "outlook:<id>", as everywhere else).
 *
 * A mailbox that fails is logged and left out, never passed off as empty
 * mail: when every connected mailbox fails the call throws. `null` means no
 * mailbox is connected at all.
 */
import "server-only";
import { getRecentEmails, getSentEmails, type GmailMessage } from "@/lib/google/gmail";
import { queryOutlookMessages } from "@/lib/microsoft/outlook-mail";
import { connectedMailboxes } from "@/lib/microsoft/mail-provider";

export interface UnifiedMail {
  messages: GmailMessage[];
  /** Mailboxes read successfully. */
  read: Array<"gmail" | "outlook">;
  /** Connected mailboxes that could not be read — their mail is missing. */
  failed: Array<"gmail" | "outlook">;
}

const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

async function merged(
  username: string,
  max: number,
  days: number,
  gmail: (u: string, n: number, d: number) => Promise<GmailMessage[]>,
  folder: "inbox" | "sent",
): Promise<UnifiedMail | null> {
  const boxes = await connectedMailboxes(username);
  if (!boxes.google && !boxes.microsoft) return null;
  const [g, o] = await Promise.allSettled([
    boxes.google ? gmail(username, max, days) : Promise.resolve(null),
    boxes.microsoft ? queryOutlookMessages(username, undefined, { maxResults: max, maxAgeDays: days, folder }) : Promise.resolve(null),
  ]);
  const read: UnifiedMail["read"] = [];
  const failed: UnifiedMail["failed"] = [];
  const messages: GmailMessage[] = [];
  if (boxes.google) {
    if (g.status === "fulfilled" && g.value) { read.push("gmail"); messages.push(...g.value); }
    else { failed.push("gmail"); console.warn(`[mail] Gmail ${folder} unreadable:`, g.status === "rejected" ? short(g.reason) : "no client"); }
  }
  if (boxes.microsoft) {
    if (o.status === "fulfilled" && o.value) { read.push("outlook"); messages.push(...o.value.map((m) => ({ ...m, id: `outlook:${m.id}` }))); }
    else { failed.push("outlook"); console.warn(`[mail] Outlook ${folder} unreadable:`, o.status === "rejected" ? short(o.reason) : "sign-in expired"); }
  }
  if (read.length === 0) throw new Error(`No mailbox could be read (${failed.join(", ")}).`);
  messages.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  return { messages: messages.slice(0, max * read.length), read, failed };
}

/** Recent inbox mail from every connected mailbox, newest first. */
export function recentInbox(username: string, max: number, days: number): Promise<UnifiedMail | null> {
  return merged(username, max, days, getRecentEmails, "inbox");
}

/** The user's own recent sent mail from every connected mailbox — resolution evidence only. */
export function recentSent(username: string, max: number, days: number): Promise<UnifiedMail | null> {
  return merged(username, max, days, getSentEmails, "sent");
}

/** "Gmail and Outlook" / "Outlook" — for prompt labels. */
export function mailboxLabel(m: UnifiedMail | null): string {
  if (!m) return "email";
  return m.read.map((b) => (b === "gmail" ? "Gmail" : "Outlook")).join(" and ");
}
