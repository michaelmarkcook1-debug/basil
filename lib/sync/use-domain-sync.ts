"use client";

/**
 * useDomainSync — wire a page/component into the Basil sync channel.
 *
 * Call this once per domain you care about. Pass your existing `refresh`
 * function (stable or not — handled internally via ref). Returns a `notify`
 * function to call after any local mutation.
 *
 * The returned `notify` is stable (useCallback with domain dep only), safe
 * to put in dependency arrays.
 *
 * Flow
 * ────
 *   1. Local mutation completes (fetch resolves).
 *   2. Component calls notify().
 *   3. notify() → emitChange(domain).
 *   4. Same tab:  CustomEvent fires synchronously → refresh() called.
 *   5. Other tabs: BroadcastChannel message arrives → refresh() called.
 *
 * Because CustomEvent dispatch is synchronous, same-tab refresh starts
 * immediately inside notify() — no perceptible lag.
 *
 * Usage
 * ─────
 *   const notify = useDomainSync("actions", refresh);
 *
 *   async function handleAdd() {
 *     await fetch("/api/actions", { method: "POST", body: ... });
 *     notify(); // triggers refresh here + in every other open surface
 *   }
 */

import { useCallback, useEffect, useRef } from "react";
import { emitChange, onDomainChange, type SyncDomain } from "./channel";

export function useDomainSync(
  domain: SyncDomain,
  refresh: () => void | Promise<void>
): () => void {
  // Keep a ref to the latest refresh function so the subscription effect
  // never needs to re-run due to refresh identity changes between renders.
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  });

  useEffect(() => {
    const handler = () => {
      void refreshRef.current();
    };
    return onDomainChange(domain, handler);
  }, [domain]); // intentionally omits refresh — accessed via ref

  // notify() is the outbound half: call it after any successful mutation.
  return useCallback(() => emitChange(domain), [domain]);
}
