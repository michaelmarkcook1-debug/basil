/**
 * Password-reset token store.
 *
 * Sprint 2D hardening: raw token values are never stored.
 * Only SHA-256(token) is persisted (via secure-auth-store which AES-encrypts
 * the record set). The raw token is returned to the caller (who puts it in a
 * reset URL), but is never written to storage.
 *
 * Tokens are short-lived (15 min), one-time-use.
 */

import {
  readResetTokenRecords,
  writeResetTokenRecords,
  hashResetToken,
} from "@/lib/storage/secure-auth-store";
import { withLock } from "@/lib/storage/lock";
import { randomBytes } from "node:crypto";

const TTL_MS = 60 * 60 * 1000; // 1 hour
// Single global lock: the reset-token file is one shared record set, so every
// create/consume must serialise (and read fresh) or a concurrent write can drop
// a just-issued token or resurrect a consumed one across serverless instances.
const RESET_LOCK = "secure-reset-tokens";

/**
 * Create a reset token for the given user.
 * Any previous tokens for this user are invalidated.
 *
 * Returns the raw (unhashed) token string for inclusion in a reset URL.
 * The raw token is never persisted — only its SHA-256 hash is stored.
 */
export async function createResetToken(username: string, email: string): Promise<string> {
  return withLock(RESET_LOCK, async () => {
    const now = Date.now();
    const records = await readResetTokenRecords(true);

    // Drop expired/used tokens AND any existing tokens for this user in one pass.
    const others = records.filter(
      (t) =>
        !t.used &&
        new Date(t.expiresAt).getTime() > now &&
        t.username.toLowerCase() !== username.toLowerCase(),
    );

    const rawToken = randomBytes(32).toString("hex");
    const entry = {
      tokenHash: hashResetToken(rawToken),
      username,
      email,
      expiresAt: new Date(now + TTL_MS).toISOString(),
      used: false,
    };

    await writeResetTokenRecords([...others, entry]);
    return rawToken; // raw token returned to caller; never stored
  });
}

/**
 * Validate a reset token WITHOUT consuming it — advisory only, for showing or
 * hiding a form. Reads fresh so a warm instance cannot report a consumed token
 * as still valid. Never gate a password change on this: use claimResetToken().
 */
export async function validateResetToken(presentedToken: string): Promise<string | null> {
  const tokenHash = hashResetToken(presentedToken);
  const records = await readResetTokenRecords(true);
  const entry = records.find((t) => t.tokenHash === tokenHash);
  if (!entry || entry.used) return null;
  if (new Date(entry.expiresAt).getTime() < Date.now()) return null;
  return entry.username;
}

/**
 * Consume (mark as used) a reset token after a successful password change.
 * Hashes the presented token to find the stored record.
 */
export async function consumeResetToken(presentedToken: string): Promise<void> {
  const tokenHash = hashResetToken(presentedToken);
  await withLock(RESET_LOCK, async () => {
    const records = await readResetTokenRecords(true);
    const idx = records.findIndex((t) => t.tokenHash === tokenHash);
    if (idx !== -1) {
      records[idx] = { ...records[idx], used: true };
      await writeResetTokenRecords(records);
    }
  });
}

/**
 * Atomically claim a reset token: under the store lock, on a fresh read, find
 * an unused, unexpired record for this token and mark it used in the same
 * write. Returns the username, or null if there is nothing to claim.
 *
 * This replaces validate → change password → consume, which had two holes:
 * validate read the /tmp cache, so a second warm instance could still see
 * `used: false` after the first had consumed it; and consumption came after
 * the password change, leaving a window in which two requests could both pass
 * validation. The claim closes both — one durable transition, before any
 * password is touched.
 */
export async function claimResetToken(presentedToken: string): Promise<string | null> {
  const tokenHash = hashResetToken(presentedToken);
  return withLock(RESET_LOCK, async () => {
    const records = await readResetTokenRecords(true);
    const idx = records.findIndex((t) => t.tokenHash === tokenHash);
    if (idx === -1) return null;
    const entry = records[idx];
    if (entry.used || new Date(entry.expiresAt).getTime() < Date.now()) return null;
    records[idx] = { ...entry, used: true };
    await writeResetTokenRecords(records);
    return entry.username;
  });
}

/**
 * Give a claimed token back. Only for the case where the claim succeeded but
 * the password write failed — the user still holds a link that should work,
 * and the expiry still bounds it. Never called on success.
 */
export async function releaseResetToken(presentedToken: string): Promise<void> {
  const tokenHash = hashResetToken(presentedToken);
  await withLock(RESET_LOCK, async () => {
    const records = await readResetTokenRecords(true);
    const idx = records.findIndex((t) => t.tokenHash === tokenHash);
    if (idx !== -1 && records[idx].used) {
      records[idx] = { ...records[idx], used: false };
      await writeResetTokenRecords(records);
    }
  });
}
