import { contacts as seedContacts, type Contact } from "./contacts-data";

/**
 * Match a single contact against a lookup string (name or email). Shared by
 * both the seed list and any extra contacts the caller passes through.
 */
function matches(c: Contact, lower: string): boolean {
  return (
    c.name.toLowerCase() === lower ||
    c.name.toLowerCase().includes(lower) ||
    (c.name.split(" ")[0].length >= 3 &&
      lower.includes(c.name.split(" ")[0].toLowerCase())) ||
    (!!c.email && lower === c.email.toLowerCase())
  );
}

/**
 * Find a contact by name or email. Seed contacts are always searched; pass
 * `extra` to also consider user-added contacts from the client's localStorage
 * (forwarded through the request body — they aren't readable server-side
 * otherwise).
 */
export function findContactByName(
  name: string,
  extra: Contact[] = []
): Contact | undefined {
  const lower = name.toLowerCase();
  return (
    extra.find((c) => matches(c, lower)) ||
    seedContacts.find((c) => matches(c, lower))
  );
}

export function findContactByEmail(
  email: string,
  extra: Contact[] = []
): Contact | undefined {
  const lower = email.toLowerCase();
  return (
    extra.find((c) => c.email?.toLowerCase() === lower) ||
    seedContacts.find((c) => c.email?.toLowerCase() === lower)
  );
}

export function getPersonaSummary(contact: Contact): string {
  return `${contact.name} (${contact.title}): ${contact.personality.substring(0, 200)}... Motivations: ${contact.whatMakesThemTick.substring(0, 150)}. Watch out: ${contact.watchOut.substring(0, 150)}`;
}

export function getAllPersonaSummaries(): string {
  return seedContacts
    .map(
      (c) =>
        `- **${c.name}** (${c.title}): Personality: ${c.personality.substring(0, 120)}... Tick: ${c.whatMakesThemTick.substring(0, 80)}. Watch: ${c.watchOut.substring(0, 80)}.`
    )
    .join("\n");
}
