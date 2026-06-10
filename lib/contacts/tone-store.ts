/**
 * Writes tone/attitude observations to the contact override store.
 *
 * Matches a person name (extracted by the AI classifier) to a contact ID by
 * doing a fuzzy name match across seed contacts + the user's added contacts.
 * If no match is found the observation is dropped — we never create orphaned
 * records for unknown people.
 */

import type { ToneObservation } from "@/lib/contact-profile-overrides";
import type { ToneShift } from "@/lib/email/classify-email";
import { contacts as SEED_CONTACTS } from "@/lib/contacts-data";
import { listUserContacts } from "@/lib/contacts/user-store";
import { appendToneObservation } from "@/lib/contacts/overrides-store";

// ── Name matching ─────────────────────────────────────────────────────────────

/**
 * Normalize a name for comparison: lowercase, collapse whitespace,
 * strip common honorifics.
 */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(mr|mrs|ms|dr|prof)\.?\s+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Returns true when `candidate` (a stored contact name) is a plausible match
 * for `query` (the AI-extracted person name).
 *
 * Matching rules (in priority order):
 *  1. Exact normalized match
 *  2. Stored name contains all words in the query (handles "Sam" matching "Sam Rivera")
 *  3. Query contains all words in the stored name (handles "Jordan Avery" matching "Jordan")
 */
function isNameMatch(query: string, candidate: string): boolean {
  const q = normalizeName(query);
  const c = normalizeName(candidate);
  if (q === c) return true;

  const qWords = q.split(" ").filter(Boolean);
  const cWords = c.split(" ").filter(Boolean);

  // All query words appear in candidate name
  if (qWords.every((w) => cWords.includes(w))) return true;
  // All candidate words appear in query
  if (cWords.every((w) => qWords.includes(w))) return true;

  return false;
}

/**
 * Find the contact ID for a given person name.
 * Checks seed contacts first (faster, no I/O), then user contacts.
 * Returns undefined if no match.
 */
async function findContactIdByName(
  username: string,
  personName: string
): Promise<string | undefined> {
  // Seed contacts (compile-time, no I/O)
  const seedMatch = SEED_CONTACTS.find((c) => isNameMatch(personName, c.name));
  if (seedMatch) return seedMatch.id;

  // User-added contacts
  const userContacts = await listUserContacts(username).catch(() => []);
  const userMatch = userContacts.find((c) => isNameMatch(personName, c.name));
  return userMatch?.id;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Write tone shift observations from the AI to the relevant contact overrides.
 *
 * Each tone shift is matched to a contact by name. Unmatched names are silently
 * skipped. Errors on individual writes are caught and logged so one bad write
 * doesn't abort others.
 *
 * @param username   User whose stores to write to.
 * @param toneShifts Array of shifts extracted by the AI classifier.
 * @param date       ISO date string of the source message.
 * @param source     "email" | "slack" | "zoom"
 * @param sourceRef  Full source ref (e.g. "gmail:<id>") for dedup.
 */
export async function writeToneObservations(
  username: string,
  toneShifts: ToneShift[],
  date: string,
  source: "email" | "slack" | "zoom",
  sourceRef: string
): Promise<void> {
  for (const shift of toneShifts) {
    if (!shift.person?.trim() || !shift.summary?.trim()) continue;

    try {
      const contactId = await findContactIdByName(username, shift.person);
      if (!contactId) {
        console.log(
          `[tone-store] no contact match for "${shift.person}" — skipping tone observation`
        );
        continue;
      }

      const observation: ToneObservation = {
        date: date.slice(0, 10),
        person: shift.person.trim(),
        direction: shift.direction,
        summary: shift.summary.trim(),
        source,
        sourceRef,
      };

      await appendToneObservation(username, contactId, observation);
      console.log(
        `[tone-store] wrote ${shift.direction} tone observation for "${shift.person}" (contact: ${contactId})`
      );
    } catch (err) {
      console.error(
        `[tone-store] failed to write tone observation for "${shift.person}":`,
        err instanceof Error ? err.message : err
      );
    }
  }
}
