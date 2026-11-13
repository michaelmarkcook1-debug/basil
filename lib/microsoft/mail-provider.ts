/**
 * Which mailbox an email action goes through: Gmail or Outlook.
 *
 * Gmail when Google is connected (it is the primary account), Outlook when
 * only Microsoft 365 is — and always Outlook for a message that came from
 * Outlook (ids from Outlook ingestion start with "outlook:"), so a reply
 * stays in the conversation it answers.
 */
import { isGoogleConnected } from "@/lib/google/auth";
import { isMicrosoftConnected } from "./auth";
import { isOutlookMessageId } from "./outlook-mail";

export type MailProvider = "google" | "microsoft";

/** Pure — exported for tests. Null when the needed account is not connected. */
export function pickMailProvider(connected: { google: boolean; microsoft: boolean }, messageId?: string): MailProvider | null {
  if (messageId && isOutlookMessageId(messageId)) return connected.microsoft ? "microsoft" : null;
  if (connected.google) return "google";
  if (connected.microsoft) return "microsoft";
  return null;
}

export async function connectedMailboxes(username: string): Promise<{ google: boolean; microsoft: boolean }> {
  const [google, microsoft] = await Promise.all([
    isGoogleConnected(username).catch(() => false),
    isMicrosoftConnected(username, "mail").catch(() => false),
  ]);
  return { google, microsoft };
}

export async function mailProviderFor(username: string, messageId?: string): Promise<MailProvider | null> {
  return pickMailProvider(await connectedMailboxes(username), messageId);
}
