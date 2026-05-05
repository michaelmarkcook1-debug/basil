/**
 * session-user — lightweight client-side username store.
 *
 * Stores the logged-in username in localStorage under "basil:session-user"
 * so that usePersistentDraft can scope its keys per user without an async
 * server round-trip.
 *
 * Rules:
 *   setSessionUsername()  — call from login page after successful auth
 *   clearSessionUsername() — call on 401 / account delete / password change
 *
 * The value is NOT sensitive: it's just the username (not the session token).
 * Real session security comes from the httpOnly cookie handled server-side.
 */

const SESSION_USER_KEY = "basil:session-user";

/** Returns the stored username, or null if not logged in / SSR context. */
export function getSessionUsername(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(SESSION_USER_KEY);
  } catch {
    return null;
  }
}

/** Call after a successful login to scope draft keys to this user. */
export function setSessionUsername(username: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(SESSION_USER_KEY, username);
  } catch {
    /* localStorage unavailable — degrade silently */
  }
}

/**
 * Call on logout, 401 redirect, account delete, or password change.
 * Clears the username so the next user's drafts start fresh.
 */
export function clearSessionUsername(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(SESSION_USER_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Build a username-scoped localStorage key.
 * Format: "basil:<username>:<key>" or "basil:<username>:<key>:<entityId>"
 * Falls back to "basil:<key>" when no user is stored (should not happen in normal use).
 */
export function scopedKey(key: string, entityId?: string): string {
  const parts = ["basil"];
  const username = getSessionUsername();
  if (username) parts.push(username);
  parts.push(key);
  if (entityId) parts.push(entityId);
  return parts.join(":");
}
