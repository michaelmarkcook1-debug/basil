/**
 * lib/contacts/suppressions.ts — people the user has deleted.
 *
 * Deleting a connection has to stick. The suggestion strip mines recent email
 * and Slack for people who are not yet contacts, so without this a deleted
 * person reappeared as a "suggested connection" on the next scan — and the
 * only record of the deletion was a per-browser tombstone. This list is
 * per-user and server-side, so every device and the suggester honour it.
 */
import { readUserStore, updateUserStore } from "@/lib/storage/user-store";

const FILE = "sage-contact-suppressions.json";

export interface ContactSuppressions {
  emails: string[];
  names: string[];
}
const EMPTY: ContactSuppressions = { emails: [], names: [] };
const norm = (s: string) => s.trim().toLowerCase();

export async function getContactSuppressions(username: string): Promise<ContactSuppressions> {
  const s = await readUserStore<ContactSuppressions>(username, FILE, EMPTY);
  return { emails: s.emails ?? [], names: s.names ?? [] };
}

export async function suppressContact(username: string, who: { name?: string; email?: string }): Promise<void> {
  await updateUserStore<ContactSuppressions>(
    username,
    FILE,
    (cur) => {
      const emails = new Set((cur.emails ?? []).map(norm));
      const names = new Set((cur.names ?? []).map(norm));
      if (who.email?.trim()) emails.add(norm(who.email));
      if (who.name?.trim()) names.add(norm(who.name));
      return { emails: [...emails], names: [...names] };
    },
    EMPTY,
  );
}

export function isSuppressed(s: ContactSuppressions, name?: string, email?: string): boolean {
  if (email && s.emails.includes(norm(email))) return true;
  if (name && s.names.includes(norm(name))) return true;
  return false;
}
