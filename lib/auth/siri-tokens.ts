/**
 * Siri / Shortcuts API token store.
 *
 * iOS Shortcuts can't hold a session cookie, so voice access authenticates with
 * a long-lived per-user bearer token instead. Mirrors the reset-token hardening:
 * the raw token is returned exactly once at creation and never persisted — only
 * SHA-256(token) is stored. One active token per user; regenerating revokes the
 * previous one.
 */

import { createHash, randomBytes } from "node:crypto";
import { readStore, updateStore } from "@/lib/storage/persistent";

const STORE_FILE = "siri-tokens.json";
const TOKEN_PREFIX = "bsl_";
/** Throttle lastUsedAt writes — one durable write per hour per token, not per call. */
const LAST_USED_WRITE_INTERVAL_MS = 60 * 60 * 1000;

export interface SiriTokenRecord {
  tokenHash: string;
  username: string;
  createdAt: string;
  lastUsedAt: string | null;
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * Create (or replace) the Siri token for a user.
 * Returns the raw token — the only time it is ever available.
 */
export async function createSiriToken(username: string): Promise<string> {
  const rawToken = TOKEN_PREFIX + randomBytes(32).toString("hex");
  const entry: SiriTokenRecord = {
    tokenHash: hashToken(rawToken),
    username,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  await updateStore<SiriTokenRecord[]>(
    STORE_FILE,
    (records) => [
      ...records.filter((r) => r.username.toLowerCase() !== username.toLowerCase()),
      entry,
    ],
    []
  );
  return rawToken;
}

/**
 * Verify a presented bearer token. Returns the owning username, or null.
 * Reads fresh (bypasses /tmp cache) so a revocation takes effect on the next
 * call across all serverless instances.
 */
export async function verifySiriToken(presented: string | null | undefined): Promise<string | null> {
  if (!presented || !presented.startsWith(TOKEN_PREFIX)) return null;
  const tokenHash = hashToken(presented);
  const records = await readStore<SiriTokenRecord[]>(STORE_FILE, [], undefined, { fresh: true });
  const entry = records.find((r) => r.tokenHash === tokenHash);
  if (!entry) return null;

  // Touch lastUsedAt (throttled, fire-and-forget) so Settings can show liveness.
  const last = entry.lastUsedAt ? new Date(entry.lastUsedAt).getTime() : 0;
  if (Date.now() - last > LAST_USED_WRITE_INTERVAL_MS) {
    const now = new Date().toISOString();
    void updateStore<SiriTokenRecord[]>(
      STORE_FILE,
      (records) =>
        records.map((r) => (r.tokenHash === tokenHash ? { ...r, lastUsedAt: now } : r)),
      []
    ).catch(() => undefined);
  }

  return entry.username;
}

/** Revoke the user's Siri token (no-op if none exists). */
export async function revokeSiriToken(username: string): Promise<void> {
  await updateStore<SiriTokenRecord[]>(
    STORE_FILE,
    (records) => records.filter((r) => r.username.toLowerCase() !== username.toLowerCase()),
    [],
    undefined,
    { allowShrink: true }
  );
}

/** Status for the Settings UI — never exposes the token itself. */
export async function getSiriTokenStatus(
  username: string
): Promise<{ active: boolean; createdAt: string | null; lastUsedAt: string | null }> {
  const records = await readStore<SiriTokenRecord[]>(STORE_FILE, []);
  const entry = records.find((r) => r.username.toLowerCase() === username.toLowerCase());
  return {
    active: !!entry,
    createdAt: entry?.createdAt ?? null,
    lastUsedAt: entry?.lastUsedAt ?? null,
  };
}
