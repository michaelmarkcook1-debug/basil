/**
 * Basil domain sync channel.
 *
 * Two-layer broadcast so every surface stays consistent:
 *
 *   BroadcastChannel  — native browser API; delivers to every OTHER tab on
 *                       the same origin. Does NOT fire in the sending tab.
 *   CustomEvent       — window-level event; delivers to listeners in THIS tab
 *                       only. Synchronous dispatch, so subscribers fire before
 *                       the call stack returns.
 *
 * Together they give full coverage:
 *   same-tab:   CustomEvent  → listener calls refresh()
 *   other tabs: BroadcastChannel message → listener calls refresh()
 *
 * Usage
 * ─────
 *   // After any successful mutation:
 *   emitChange("actions");
 *
 *   // To subscribe (usually via useDomainSync):
 *   const unsub = onDomainChange("actions", () => reload());
 *   // ...later:
 *   unsub();
 */

export type SyncDomain =
  | "actions"
  | "decisions"
  | "memory"
  | "events"
  | "contacts";

const BC_NAME = "basil-domain-sync";

interface SyncMessage {
  domain: SyncDomain;
  ts: number;
}

function windowEventName(domain: SyncDomain): string {
  return `basil:${domain}:changed`;
}

/**
 * Emit a domain change.
 * - Fires a window CustomEvent for same-tab listeners.
 * - Posts a BroadcastChannel message for other-tab listeners.
 * Safe to call in SSR (no-ops when window is unavailable).
 */
export function emitChange(domain: SyncDomain): void {
  if (typeof window === "undefined") return;

  // Same-tab: synchronous, fires before this function returns
  window.dispatchEvent(new CustomEvent(windowEventName(domain)));

  // Cross-tab: async, delivered to other browsing contexts
  try {
    const bc = new BroadcastChannel(BC_NAME);
    bc.postMessage({ domain, ts: Date.now() } satisfies SyncMessage);
    bc.close();
  } catch {
    // BroadcastChannel unavailable (some private-browsing modes) — same-tab
    // sync above already happened, so cross-tab simply degrades gracefully.
  }
}

/**
 * Subscribe to changes on a domain.
 * `cb` is called whenever any surface (this tab or another) emits a change.
 * Returns an unsubscribe function — always call it in cleanup.
 */
export function onDomainChange(
  domain: SyncDomain,
  cb: () => void
): () => void {
  if (typeof window === "undefined") return () => {};

  // Same-tab subscriber
  window.addEventListener(windowEventName(domain), cb);

  // Cross-tab subscriber
  let bc: BroadcastChannel | null = null;
  const bcHandler = (e: MessageEvent<SyncMessage>) => {
    if (e.data?.domain === domain) cb();
  };
  try {
    bc = new BroadcastChannel(BC_NAME);
    bc.addEventListener("message", bcHandler);
  } catch {
    // Degrade silently — same-tab sync still works
  }

  return () => {
    window.removeEventListener(windowEventName(domain), cb);
    if (bc) {
      bc.removeEventListener("message", bcHandler);
      bc.close();
    }
  };
}
