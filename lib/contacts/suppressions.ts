/**
 * lib/contacts/suppressions.ts — people the user has deleted.
 *
 * Deleting a connection has to stick. The suggestion strip mines recent email
 * and Slack for people who are not yet contacts, so without this a deleted
 * person reappeared as a "suggested connection" on the next scan — and the
 * only record of the deletion was a per-browser tombstone. This list is
 * per-user and server-side, so every device and the suggester honour it.
 */
//
// `ids` exists because a browser's local contact cache re-uploads anything the
// server lacks (lib/user-contacts.ts reconcile). A deletion made anywhere but
// that browser — another device, a server-side cleanup — was undone the next
// time the People page opened: 375 deleted contacts came back within seconds
// on 2026-09-26. Imports skip these ids, and every browser is told to drop them.
import { readUserStore, updateUserStore } from "@/lib/storage/user-store";

const FILE = "sage-contact-suppressions.json";

export interface ContactSuppressions {
  emails: string[];
  names: string[];
  /** Deleted contact ids — never re-imported, and dropped from every browser's cache. */
  ids: string[];
}
const EMPTY: ContactSuppressions = { emails: [], names: [], ids: [] };
const norm = (s: string) => s.trim().toLowerCase();

export async function getContactSuppressions(
  username: string,
  options?: { fresh?: boolean },
): Promise<ContactSuppressions> {
  const s = await readUserStore<ContactSuppressions>(username, FILE, EMPTY, options);
  return { emails: s.emails ?? [], names: s.names ?? [], ids: s.ids ?? [] };
}

export async function suppressContact(username: string, who: { id?: string; name?: string; email?: string }): Promise<void> {
  await updateUserStore<ContactSuppressions>(
    username,
    FILE,
    (cur) => {
      const emails = new Set((cur.emails ?? []).map(norm));
      const names = new Set((cur.names ?? []).map(norm));
      const ids = new Set(cur.ids ?? []);
      if (who.email?.trim()) emails.add(norm(who.email));
      if (who.name?.trim()) names.add(norm(who.name));
      if (who.id?.trim()) ids.add(who.id.trim());
      return { emails: [...emails], names: [...names], ids: [...ids] };
    },
    EMPTY,
  );
}

/** The user added this contact back themselves — let it stay. */
export async function unsuppressContactId(username: string, id: string): Promise<void> {
  await updateUserStore<ContactSuppressions>(
    username,
    FILE,
    (cur) => ({ emails: cur.emails ?? [], names: cur.names ?? [], ids: (cur.ids ?? []).filter((x) => x !== id) }),
    EMPTY,
  );
}

export function isSuppressed(s: ContactSuppressions, name?: string, email?: string): boolean {
  if (email && s.emails.includes(norm(email))) return true;
  if (name && s.names.includes(norm(name))) return true;
  return false;
}
