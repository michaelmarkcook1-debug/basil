/**
 * lib/contacts/linkedin-from-signature.ts
 *
 * Harvest LinkedIn profile URLs from email signatures.
 *
 * WHY THIS AND NOT THE LINKEDIN PLUGIN
 * LinkedIn's AutoFill plugin fills a form from the profile of whoever is
 * sitting at the browser, after they click and consent — it can only ever
 * return the VISITOR'S OWN profile, and only on a domain LinkedIn has
 * allowlisted. It structurally cannot populate a third party's details, so it
 * is no use for enriching a contact list. The profile API is the same story:
 * it returns the authenticated member, not arbitrary people.
 *
 * But the data is already sitting in the inbox. People put their LinkedIn URL
 * in their email signature, Basil already fetches full email bodies for
 * classification, and a URL in the signature of a message FROM someone is
 * self-asserted — no scraping, no API, no approval, and it works retroactively
 * on mail already received.
 *
 * Pure module (no I/O) so the matching is exhaustively testable.
 *
 * ATTRIBUTION SAFETY — the reason this is sender-scoped upstream:
 * a URL found in a body is only evidence about the SENDER. Newsletters and
 * forwarded threads routinely mention other people's profiles, so attaching any
 * URL found in any email would confidently write the wrong profile onto a
 * contact. The caller must only ever apply this to the sender of the message.
 */

/** A LinkedIn personal-profile URL, normalised for storage and comparison. */
export interface LinkedInProfile {
  /** Canonical https://www.linkedin.com/in/<slug> form. */
  url: string;
  /** The vanity slug — stable identity for dedupe. */
  slug: string;
}

/**
 * Matches personal profile links only.
 *
 * Deliberately NOT /company/, /school/, /pulse/, /feed/, /posts/ or /jobs/ —
 * those are pages, articles and org profiles, and storing one as a person's
 * profile is worse than storing nothing. Country subdomains (uk., de., ca.…)
 * and the "m." mobile host are common in signatures and all normalise to www.
 *
 * lnkd.in short links are intentionally ignored: resolving them needs a network
 * fetch, and guessing what they point at is how a wrong profile gets attached.
 */
const PROFILE_RE =
  /(?:https?:\/\/)?(?:(?:[a-z]{2,3}|www|m)\.)?linkedin\.com\/in\/([A-Za-z0-9\-_%À-ÿ.]{2,100})/gi;

/** Trailing punctuation that regularly rides along in plain-text signatures. */
const TRAILING_JUNK = /[.,;:)\]}>"'|]+$/;

/**
 * Extract every distinct LinkedIn personal profile referenced in a block of
 * text. Works on plain text and raw HTML alike — an href="…" match is just a
 * URL in the string, so no HTML parsing is needed.
 *
 * Ordered by first appearance; signatures put the owner's link first.
 */
export function extractLinkedInProfiles(text: string): LinkedInProfile[] {
  if (!text) return [];
  const out: LinkedInProfile[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(PROFILE_RE)) {
    let slug = (match[1] ?? "").replace(TRAILING_JUNK, "");
    // Strip a trailing slash-path or query that the character class let through.
    slug = slug.split(/[/?#]/)[0] ?? "";
    if (!slug) continue;
    // Decode %-escapes so the same person written two ways dedupes to one.
    try {
      slug = decodeURIComponent(slug);
    } catch {
      // Malformed escape — keep the raw form rather than dropping a real hit.
    }
    const key = slug.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ slug, url: `https://www.linkedin.com/in/${slug}` });
  }

  return out;
}

/**
 * The single best profile to attribute to the SENDER of a message.
 *
 * Returns null when the answer is ambiguous. A signature block normally carries
 * exactly one personal profile; when a body mentions several (a forwarded
 * thread, an intro email naming three people) there is no reliable way to tell
 * which one belongs to the sender, and a confident wrong answer is worse than
 * no answer — a mis-attributed profile is one the user has to notice to fix.
 */
export function senderProfileFrom(body: string): LinkedInProfile | null {
  const found = extractLinkedInProfiles(body);
  return found.length === 1 ? found[0] : null;
}

/**
 * A LinkedIn people-search URL for a contact with no profile stored yet.
 *
 * Not a guess at their profile — a prefilled search the user can click to find
 * and attach the right person in one step. Storing a guessed vanity URL would
 * be a fabricated record; a search link is honest about being a starting point.
 */
export function linkedInSearchUrl(name: string, company?: string): string {
  const q = [name, company].filter((s) => s && s.trim()).join(" ").trim();
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(q)}`;
}
