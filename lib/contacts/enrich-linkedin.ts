import "server-only";

import { listUserContacts, updateUserContactInStore } from "@/lib/contacts/user-store";
import { senderProfileFrom } from "@/lib/contacts/linkedin-from-signature";
import { getSettings } from "@/lib/settings/store";

/**
 * Attach a LinkedIn profile to a contact from the sender's own email signature.
 *
 * The only reliable, permitted source of third-party LinkedIn data available
 * here. LinkedIn's AutoFill plugin and profile API both return only the
 * AUTHENTICATED member's own profile, so neither can enrich a contact list —
 * but people publish their profile URL in their own signature, and Basil
 * already fetches full bodies for classification. No API, no allowlisting, no
 * extra cost, and it works on mail already received.
 *
 * Deliberately conservative — a wrong profile on a contact is worse than an
 * empty field, because the user has to notice it to fix it:
 *   • matched by EMAIL ADDRESS only, never by display name (names collide,
 *     and "Michael" in a signature proves nothing about who sent it)
 *   • only applied to the SENDER of the message, so a profile mentioned in a
 *     newsletter or a forwarded intro is never attributed to them
 *   • ambiguous bodies (several profiles) are skipped entirely — see
 *     senderProfileFrom
 *   • an existing value is NEVER overwritten; anything the user set wins
 *   • never creates a contact — enrichment only fills gaps on records that
 *     already exist
 *
 * Never throws: enrichment is a bonus, and must not be able to fail an ingest.
 *
 * @param rawBody The UNSTRIPPED body. HTML signatures carry the URL in an
 *                href attribute, and the pipeline's stripHtml() removes whole
 *                tags — so the stripped text has already lost it.
 * @returns the URL stored, or null when nothing was applied.
 */
export async function enrichContactLinkedIn(
  username: string,
  fromEmail: string | undefined,
  rawBody: string,
): Promise<string | null> {
  try {
    const email = (fromEmail ?? "").trim().toLowerCase();
    if (!email || !email.includes("@")) return null;

    // The user's own profile is excluded before attribution. A reply quotes the
    // user's signature beneath the sender's, so without this a sender who has no
    // LinkedIn of their own leaves exactly one profile in the body — the user's —
    // and it gets attached to them. Reading settings costs one store read and
    // only happens once a candidate profile is already present.
    const selfProfile = await getSettings(username)
      .then((s) => s.linkedin)
      .catch(() => undefined);   // settings unreadable → fall back to no exclusion

    const profile = senderProfileFrom(rawBody, selfProfile);
    if (!profile) return null;

    const contacts = await listUserContacts(username);
    const match = contacts.find((c) => (c.email ?? "").trim().toLowerCase() === email);
    if (!match) return null;               // never invent a contact
    if (match.linkedin?.trim()) return null; // never overwrite a known value

    await updateUserContactInStore(username, match.id, { linkedin: profile.url });
    console.log(
      `[linkedin-enrich] ${match.name} <${email}> → ${profile.url} (from their email signature)`
    );
    return profile.url;
  } catch (err) {
    console.warn(
      "[linkedin-enrich] failed (non-fatal):",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
