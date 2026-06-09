/**
 * lib/billing/webhook-dedupe.ts — idempotency for billing webhooks.
 *
 * Payment providers retry deliveries and can deliver out of order, so the
 * webhook handler must be idempotent. We persist the last N processed provider
 * event ids and skip any we've already seen.
 *
 * NOTE: this is best-effort (non-atomic read-modify-write on Blob). The
 * entitlement mutations it guards are themselves idempotent (they set absolute
 * state, not deltas), so a rare double-apply is harmless; this dedupe mainly
 * avoids redundant work and log noise. True ordering (cancel-before-activate)
 * is handled when the real provider adapter lands, using event timestamps.
 *
 * server-only.
 */

import "server-only";
import { readStore, writeStore } from "@/lib/storage/persistent";

const FILE = "processed-events.json";
const SCOPE = "billing";
const MAX_REMEMBERED = 1000;

export async function isProcessed(eventId: string): Promise<boolean> {
  const ids = await readStore<string[]>(FILE, [], SCOPE);
  return Array.isArray(ids) && ids.includes(eventId);
}

export async function markProcessed(eventId: string): Promise<void> {
  const ids = await readStore<string[]>(FILE, [], SCOPE);
  const list = Array.isArray(ids) ? ids : [];
  if (list.includes(eventId)) return;
  list.push(eventId);
  const trimmed = list.length > MAX_REMEMBERED ? list.slice(list.length - MAX_REMEMBERED) : list;
  await writeStore(FILE, trimmed, SCOPE, { durability: "strong" });
}
