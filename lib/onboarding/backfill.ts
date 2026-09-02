/**
 * lib/onboarding/backfill.ts — kick a user's first data sync on connect.
 *
 * Without this, a user finishes onboarding and stares at an empty dashboard
 * until the next scheduled cron (up to ~18h later) — the worst possible first
 * impression. Firing a one-off backfill the moment they connect an integration
 * fills the dashboard within a minute or two instead.
 *
 * Fire-and-forget, server-to-server (CRON_SECRET + X-Basil-Username). Wrap the
 * call in next/server `after()` at the call site so it runs after the OAuth
 * redirect is sent and never blocks it.
 *
 * server-only.
 */

import "server-only";
import { selfOrigin } from "@/lib/http/origin";
import { markSyncStarted } from "@/lib/onboarding/sync-status";

function appBaseUrl(): string | undefined {
  // Self-call: must address THIS deployment. Resolving it from APP_URL first is
  // what let a repointed public alias send four subsystems into another
  // application — see lib/http/origin.ts.
  if (process.env.VERCEL_URL) return selfOrigin();
  return process.env.NODE_ENV !== "production" ? "http://localhost:3000" : undefined;
}

/**
 * Pull recent signal, classify it, and generate the first briefing for a
 * just-connected user. Each step is a loopback call into the existing worker
 * routes, so each runs in its own function invocation with its own timeout
 * budget. Best-effort: never throws, logs each step.
 */
export async function triggerOnboardingBackfill(username: string): Promise<void> {
  const cronSecret = process.env.CRON_SECRET;
  const base = appBaseUrl();
  if (!cronSecret || !base) {
    console.info(`[backfill] skipped for ${username} — CRON_SECRET or app URL not configured`);
    return;
  }

  const headers = {
    authorization: `Bearer ${cronSecret}`,
    "x-basil-username": username,
  };

  // Mark the sync window so the dashboard shows "first sync in progress".
  await markSyncStarted(username);

  try {
    const ingest = await fetch(`${base}/api/events/poll-ingest`, { method: "POST", headers });
    console.info(`[backfill] ${username} poll-ingest → ${ingest.status}`);

    // Classify what we just ingested so the briefing has signal to work from.
    await fetch(`${base}/api/events/reprocess`, { method: "POST", headers }).catch((err) => {
      console.warn(`[backfill] ${username} reprocess failed:`, err instanceof Error ? err.message : err);
    });

    // Generate the first briefing so the dashboard isn't empty on first load.
    const brief = await fetch(`${base}/api/generate/briefing`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    console.info(`[backfill] ${username} first briefing → ${brief.status}`);
  } catch (err) {
    console.error(`[backfill] ${username} failed:`, err instanceof Error ? err.message : err);
  }
}
