/**
 * lib/http/origin.ts
 *
 * Two different questions that were being answered by the same env var.
 *
 * WHAT WENT WRONG (found 2026-09-02). Basil's cron jobs fan out to their own
 * API over HTTP, resolving the target from APP_URL. APP_URL still held
 * `ag-contracts.vercel.app` — a host that was later REASSIGNED to a different
 * project. So every nightly run POSTed into another application and took a 404:
 * ingest, reprocess, briefing generation and sync-now, silently, for a week.
 * Nothing alerted, because each cron reported ok:true at the top level while
 * every per-user result inside it had failed.
 *
 * The env var was stale, but the deeper fault is that a SELF-call was resolved
 * from a configurable PUBLIC address. Those are different questions:
 *
 *   selfOrigin()   — "where am I?" Used to call my own API. Must always be this
 *                    running deployment, and must not be repointable.
 *   publicOrigin() — "where do users reach me?" Used in emails, OAuth redirect
 *                    URIs and anything a human or third party will follow. This
 *                    one SHOULD be configurable, because it must match what is
 *                    registered with Google/Microsoft and what users bookmark.
 */

/**
 * The origin of the currently-running deployment.
 *
 * VERCEL_URL is injected per deployment and always addresses this exact build,
 * so it cannot be pointed at another project by an env change or an alias move.
 * APP_URL is only a fallback for non-Vercel environments.
 */
export function selfOrigin(): string {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, "");
  return "http://localhost:3000";
}

/**
 * The address users and third parties reach Basil on.
 *
 * Deliberately NOT VERCEL_URL: that changes with every deployment, so a link in
 * an email would rot, and an OAuth redirect built from it would never match the
 * URI registered with the provider.
 */
export function publicOrigin(): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, "");
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}
