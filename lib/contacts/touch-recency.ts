import "server-only";

import { listUserContacts, updateUserContactInStore } from "@/lib/contacts/user-store";

/**
 * Cross-source contact-recency writer.
 *
 * The delta engine's "Stakeholder has gone quiet" signal reads only the stored
 * `contact.lastInteraction` field (lib/delta/compute.ts). Historically that field
 * was bumped almost exclusively by inbound EMAIL, so a contact you spoke to this
 * week over Slack (DM or shared channel) or on a Zoom call still looked silent.
 *
 * This helper lets every ingestion source push a per-person interaction date onto
 * the matching user contact — Slack authors + DM members (poll-ingest) and Zoom
 * attendees (processZoomEmail) — so recency reflects ALL channels, not just email.
 *
 * Matching mirrors poll-ingest's original touchContactLastInteraction: a contact
 * matches when its full name or first name overlaps the incoming display name
 * (handles "Matt" ↔ "Matt Paquette" and DM channelMembers which are lower-cased
 * first names). Seed/sample contacts are read-only and live outside this store.
 */
export interface RecencyTouch {
  /** Display name / first name from the source (Slack author, DM member, Zoom attendee). */
  name: string;
  /** ISO date of the interaction. */
  date: string;
  /** Provenance label stored on the contact (e.g. "slack", "zoom", "calendar"). */
  source?: string;
  /**
   * Email when the source has one (calendar attendees are often RAW emails —
   * Google omits displayName for many guests). Matched against contact.email
   * BEFORE any name heuristics: an email match is exact and can't false-positive.
   */
  email?: string;
}

function bestMatchId(
  name: string,
  contacts: Array<{ id: string; name: string; email?: string }>,
  email?: string
): string | undefined {
  // Email first — exact, case-insensitive, immune to nickname drift.
  const emailLower = (email ?? (name.includes("@") ? name : "")).trim().toLowerCase();
  if (emailLower) {
    const byEmail = contacts.find((c) => c.email?.trim().toLowerCase() === emailLower);
    if (byEmail) return byEmail.id;
    // A raw email with no contact.email on file still carries a first-name hint
    // in its local part ("trey@talentgenius.io" → "trey"); fall through with it.
    name = emailLower.split("@")[0];
  }

  const nameLower = name.trim().toLowerCase();
  if (!nameLower) return undefined;
  // A single token (no space) is a bare first name — e.g. Slack DM channelMembers
  // store lower-cased first names like "matt". Substring matching on these caused
  // false positives ("daniel" ⊃ "dan", "samantha" ⊃ "sam") that advanced the WRONG
  // contact's recency, so single-token inputs require EXACT first-name / full-name
  // equality. Full display names ("Matt Paquette") keep the looser containment.
  const singleToken = !nameLower.includes(" ");
  const match = contacts.find((c) => {
    const full = c.name.trim().toLowerCase();
    if (!full) return false;
    const first = full.split(" ")[0];
    if (singleToken) {
      return nameLower === full || nameLower === first;
    }
    return (
      nameLower.includes(full) ||
      full.includes(nameLower) ||
      (first.length > 2 && nameLower === first)
    );
  });
  return match?.id;
}

/**
 * Apply a batch of recency touches to the user's contacts. Loads the contact list
 * once, collapses touches to the newest date per matched contact, and writes only
 * when the new date is strictly newer than the stored `lastInteraction`. Fully
 * non-fatal — any failure is swallowed so ingestion never breaks on a recency write.
 *
 * @returns the number of contacts whose lastInteraction was advanced.
 */
export async function touchContactsRecency(
  username: string,
  touches: RecencyTouch[]
): Promise<number> {
  if (!touches.length) return 0;

  const contacts = await listUserContacts(username).catch(() => []);
  if (!contacts.length) return 0;

  // Collapse to the newest (date, source) per matched contact id.
  const newest = new Map<string, { date: string; source?: string }>();
  for (const t of touches) {
    if (!t.name?.trim() || !t.date) continue;
    const id = bestMatchId(t.name, contacts, t.email);
    if (!id) continue;
    const cur = newest.get(id);
    if (!cur || t.date > cur.date) newest.set(id, { date: t.date, source: t.source });
  }

  let advanced = 0;
  for (const [id, { date, source }] of newest) {
    const c = contacts.find((x) => x.id === id);
    // Only advance recency forward (string comparison is valid for ISO dates).
    if (c?.lastInteraction && c.lastInteraction >= date) continue;
    const ok = await updateUserContactInStore(username, id, {
      lastInteraction: date,
      ...(source ? { activitySource: source } : {}),
    }).then(
      () => true,
      () => false
    );
    if (ok) advanced++;
  }
  return advanced;
}
