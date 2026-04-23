// ── Cross-instance event delivery ─────────────────────────────────────────────
//
// The previous implementation used an in-process Set<Listener> — fine for
// local dev (single process) but broken on Vercel Fluid Compute: an ingest
// request can land on instance A while the SSE stream is held open on instance
// B.  Listeners registered on B are never called.
//
// NEW APPROACH — store-poll SSE:
//   The SSE route (app/api/events/stream/route.ts) now polls the persistent
//   store every 5 seconds for events newer than the last one it sent.  This
//   works across instances because every instance can read the store.
//
//   publish() and subscribe() are kept as no-ops so all existing call-sites
//   (audit.ts, ingest route) continue to compile without changes.  They
//   produce no side-effects; delivery happens via the polling loop.
//
// NOTE: true cross-instance delivery still requires each instance to see the
// same event data.  Within Fluid Compute, a cold-started instance restores its
// store from the BASIL_DATA snapshot (see lib/storage/persistent.ts) which now
// includes sage-events.json.  In the rare case of simultaneous live instances
// an event written to instance A's /tmp is not visible to instance B's poller
// until the next cold start.  For a single-user assistant this gap is
// acceptable; the client's 30-second periodic poll covers the fallback.

import type { BasilEvent } from "./types";

/** No-op — kept for backward-compatible call-sites. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function subscribe(_listener: (event: BasilEvent) => void): () => void {
  return () => {};
}

/** No-op — kept for backward-compatible call-sites. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function publish(_event: BasilEvent): void {}
