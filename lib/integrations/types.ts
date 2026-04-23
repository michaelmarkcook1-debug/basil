/**
 * Canonical integration health model used across the server and settings UI.
 *
 * Every integration check must resolve to a concrete `state` — there is no
 * "unknown" or "checking" state server-side. The UI may show a transient
 * loading indicator while the fetch is in-flight, but must always converge.
 */

export type IntegrationState =
  | "connected"           // token present + required scopes granted
  | "disconnected"        // no token / not configured
  | "token_expired"       // refresh token invalidated / revoked (needs re-auth)
  | "permission_missing"  // token present but required OAuth scope not granted
  | "syncing"             // actively fetching data (transient, set by webhooks/crons)
  | "error";              // unexpected runtime error

/** Human-readable labels for each state, suitable for badge text. */
export const STATE_LABELS: Record<IntegrationState, string> = {
  connected:          "Connected",
  disconnected:       "Not connected",
  token_expired:      "Token expired",
  permission_missing: "Permission missing",
  syncing:            "Syncing",
  error:              "Error",
};

export interface IntegrationStatus {
  /** Stable identifier, e.g. "google", "slack", "claude". */
  id: string;
  state: IntegrationState;
  /** ISO timestamp of when this status was computed. */
  lastCheckedAt: string;
  /** ISO timestamp of the last confirmed successful data exchange, if tracked. */
  lastSyncedAt?: string;
  /** Human-readable error when state === "error". */
  error?: string;
  /** For OAuth integrations: list of granted scope strings. */
  scopes?: string[];
  /** For Google: the per-scope connection breakdown. */
  google?: {
    calendar: boolean;
    gmail: boolean;
    drive: boolean;
  };
}
