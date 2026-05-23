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
import { randomBytes } from "node:crypto";

const TTL_MS = 60 * 60 * 1000; // 1 hour

/** Purge expired or used tokens to keep the file small. */
async function gc(): Promise<void> {
  const now = Date.now();
  const records = await readResetTokenRecords();
  const clean = records.filter(
    (t) => !t.used && new Date(t.expiresAt).getTime() > now
  );
  if (clean.length !== records.length) await writeResetTokenRecords(clean);
}

/**
 * Create a reset token for the given user.
 * Any previous tokens for this user are invalidated.
 *
 * Returns the raw (unhashed) token string for inclusion in a reset URL.
 * The raw token is never persisted — only its SHA-256 hash is stored.
 */
export async function createResetToken(username: string, email: string): Promise<string> {
  await gc();
  const records = await readResetTokenRecords();

  // Invalidate any existing tokens for this user
  const others = records.filter(
    (t) => t.username.toLowerCase() !== username.toLowerCase()
  );

  const rawToken = randomBytes(32).toString("hex");
  const entry = {
    tokenHash: hashResetToken(rawToken),
    username,
    email,
    expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
    used: false,
  };

  await writeResetTokenRecords([...others, entry]);
  return rawToken; // raw token returned to caller; never stored
}

/**
 * Validate a reset token.
 * Hashes the presented token and looks it up by hash.
 * Returns the username if valid, null if expired/used/not found.
 * Does NOT mark the token as used — call consumeResetToken() after
 * the password has been successfully changed.
 */
export async function validateResetToken(presentedToken: string): Promise<string | null> {
  const tokenHash = hashResetToken(presentedToken);
  const records = await readResetTokenRecords();
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
  const records = await readResetTokenRecords();
  const idx = records.findIndex((t) => t.tokenHash === tokenHash);
  if (idx !== -1) {
    records[idx] = { ...records[idx], used: true };
    await writeResetTokenRecords(records);
  }
}
