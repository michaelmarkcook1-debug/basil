import "server-only";
import { listUserContacts } from "@/lib/contacts/user-store";
import { getSelfIdentity } from "@/lib/self-identity";

/**
 * Who counts as a real correspondent when a message looks like bulk mail.
 *
 * Bulk signals (List-Unsubscribe, Gmail's Promotions tab) also appear on mail
 * that matters: a colleague posting to a Google Group, a contact's company
 * sending through HubSpot. Those senders are known — the user's own domain,
 * the domain of a work contact, or a contact's exact address — so bulk
 * filtering exempts them. Everyone else sending bulk mail is marketing.
 */

// Free mailbox providers: a contact at gmail.com must not vouch for all of gmail.com.
const PUBLIC_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "yahoo.co.uk", "icloud.com", "me.com", "mac.com", "aol.com",
  "proton.me", "protonmail.com", "gmx.com", "zoho.com", "hey.com",
]);

const domainOf = (email: string) => email.split("@")[1]?.trim().toLowerCase() ?? "";

export interface KnownSenders {
  isKnown(email: string | undefined): boolean;
}

/** Pure — exported for tests. */
export function knownSendersFrom(
  selfEmails: readonly string[],
  contacts: ReadonlyArray<{ email?: string; directory?: string }>,
): KnownSenders {
  const emails = new Set<string>();
  const domains = new Set<string>();
  const addDomain = (e: string) => {
    const d = domainOf(e);
    if (d && !PUBLIC_MAIL_DOMAINS.has(d)) domains.add(d);
  };
  for (const e of selfEmails) addDomain(e);
  for (const c of contacts) {
    const e = c.email?.trim().toLowerCase();
    if (!e || !e.includes("@")) continue;
    emails.add(e);
    if (c.directory !== "personal") addDomain(e);
  }
  return {
    isKnown(email) {
      const e = (email ?? "").trim().toLowerCase();
      return !!e && (emails.has(e) || domains.has(domainOf(e)));
    },
  };
}

export async function loadKnownSenders(username: string): Promise<KnownSenders> {
  const [identity, contacts] = await Promise.all([
    getSelfIdentity(username).catch(() => ({ emails: [] as string[], names: [] as string[] })),
    listUserContacts(username).catch(() => []),
  ]);
  return knownSendersFrom(identity.emails, contacts);
}
