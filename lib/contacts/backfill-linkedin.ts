import "server-only";

import { searchEmails, getEmailBody } from "@/lib/google/gmail";
import { enrichContactLinkedIn } from "@/lib/contacts/enrich-linkedin";

/**
 * One-off harvest of LinkedIn profiles from signatures in mail already received.
 *
 * WHY THIS IS SEPARATE FROM INGEST. enrichContactLinkedIn runs inside
 * processRegularEmail, past the content-hash gate — so it only ever sees mail
 * arriving from now on. Every signature in the mail Basil already holds has
 * never been looked at, and the events store cannot help: it persists the
 * STRIPPED body, and stripHtml() removes the whole anchor tag, taking the href
 * with it. The URL only exists in the raw message, so the raw message is what
 * has to be re-read.
 *
 * Deliberately dumb about attribution: it does not decide anything itself. Each
 * body goes through enrichContactLinkedIn, which owns every safeguard — email
 * match only, sender only, ambiguous bodies skipped, existing values never
 * overwritten, contacts never created. One place decides, so a backfill can
 * never be more permissive than live ingest.
 *
 * Idempotent by construction: because nothing is ever overwritten, running it
 * twice does nothing the first run did not.
 *
 * COST: Gmail API reads only — no AI call, so it is unaffected by the daily
 * spend cap. It is bounded and sequential regardless, because a burst of
 * hundreds of parallel message fetches is how an integration gets throttled.
 */

export interface BackfillResult {
  scanned: number;
  applied: number;
  /** Emails whose body could not be read. Reported, never silently dropped. */
  failed: number;
  profiles: { email: string; url: string }[];
  /** True when the cap stopped the scan before the window was exhausted. */
  truncated: boolean;
}

const HARD_CAP = 400;

export async function backfillLinkedIn(
  username: string,
  { maxMessages = 200, maxAgeDays = 180 }: { maxMessages?: number; maxAgeDays?: number } = {},
): Promise<BackfillResult> {
  const limit = Math.min(Math.max(1, maxMessages), HARD_CAP);
  const out: BackfillResult = { scanned: 0, applied: 0, failed: 0, profiles: [], truncated: false };

  // Inbox only. Sent mail carries the USER's own signature, and attributing the
  // user's profile to whoever they happened to write to would be wrong on every
  // record it touched.
  const messages = await searchEmails(username, "in:inbox", limit, maxAgeDays);
  out.truncated = messages.length >= limit;

  for (const msg of messages) {
    if (!msg.fromEmail) continue;
    out.scanned += 1;
    try {
      // The UNSTRIPPED body — getEmailBody returns the raw part, and the href
      // in an HTML signature is the whole point.
      const detail = await getEmailBody(username, msg.id);
      const url = await enrichContactLinkedIn(username, msg.fromEmail, detail.body);
      if (url) {
        out.applied += 1;
        out.profiles.push({ email: msg.fromEmail, url });
      }
    } catch (e) {
      // One unreadable message must not end the run, but it must be COUNTED —
      // a backfill reporting "0 applied" after silently failing on every fetch
      // looks identical to one that found nothing.
      out.failed += 1;
      console.warn(
        `[linkedin-backfill] ${msg.id} unreadable:`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  console.info(
    `[linkedin-backfill] user=${username} scanned=${out.scanned} applied=${out.applied} ` +
    `failed=${out.failed} truncated=${out.truncated}`,
  );
  return out;
}
