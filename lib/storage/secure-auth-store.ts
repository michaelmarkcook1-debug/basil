/**
 * lib/storage/secure-auth-store.ts — server-only encrypted storage for auth data.
 *
 * Sprint 2D: hardens user records and password reset tokens that were previously
 * stored as plaintext JSON in public-accessible blob storage.
 *
 * User records (users.json → secure-users.json):
 *   – The entire User[] array is AES-256-GCM encrypted before writing.
 *   – On first read, if secure-users.json is absent but users.json exists, the
 *     legacy records are migrated and encrypted transparently.
 *   – Password hashes (bcrypt) remain as-is — AES encryption wraps the blob,
 *     adding a second layer of protection. bcrypt is never replaced by reversible
 *     encryption.
 *
 * Password reset tokens (password-reset-tokens.json → secure-reset-tokens.json):
 *   – Raw token strings are never stored. Only SHA-256(token) is persisted.
 *   – Callers generate a raw token, pass it to createResetToken, get back the
 *     same raw token to include in a URL. Verification hashes the presented
 *     token and compares hashes.
 *   – Legacy password-reset-tokens.json entries are intentionally NOT migrated
 *     (tokens are short-lived; invalidating existing ones is safer than
 *     attempting to re-hash raw values we can no longer retrieve).
 *
 * IMPORTANT: This module must never be imported by client components.
 */

import "server-only";
import { createHash } from "node:crypto";
import { encrypt, decrypt, isEnvelope } from "@/lib/storage/crypto";
import type { EncryptedEnvelope } from "@/lib/storage/crypto";
import { readStore, writeStore } from "@/lib/storage/persistent";
import type { User } from "@/lib/users";

// ── Storage file names ────────────────────────────────────────────────────────

const SECURE_USERS_FILE        = "secure-users.json";
const LEGACY_USERS_FILE        = "users.json";
const SECURE_RESET_TOKENS_FILE = "secure-reset-tokens.json";
// Note: password-reset-tokens.json (legacy) is intentionally not migrated — see module doc.

// ── Hashed reset token record ─────────────────────────────────────────────────

export interface HashedResetToken {
  /** SHA-256 hex digest of the raw token. Raw token is never stored. */
  tokenHash: string;
  username:  string;
  email:     string;
  expiresAt: string; // ISO-8601
  used:      boolean;
}

// ── Token hashing ─────────────────────────────────────────────────────────────

/**
 * Compute SHA-256(rawToken) as hex.
 * Used to convert a presented reset token to its stored form.
 */
export function hashResetToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

// ── User record storage ───────────────────────────────────────────────────────

/**
 * Read the encrypted user records array from storage.
 *
 * Migration path: if secure-users.json is absent/empty but users.json exists,
 * encrypt and migrate the legacy file transparently. After migration, reads
 * always come from the encrypted file.
 *
 * Returns only file-persisted users (not the env-admin virtual user).
 * The env-admin merge is handled in lib/users.ts.
 */
export async function readUserRecords(): Promise<User[]> {
  const raw = await readStore<EncryptedEnvelope | User[] | null>(SECURE_USERS_FILE, null);

  // Happy path: encrypted envelope exists → decrypt and return
  if (raw !== null && isEnvelope(raw)) {
    try {
      return JSON.parse(decrypt(raw)) as User[];
    } catch (err) {
      console.error(
        "[secure-auth-store] Failed to decrypt user records:",
        err instanceof Error ? err.message : err
      );
      return [];
    }
  }

  // If file contains something that looks like a plain array (shouldn't happen
  // after migration, but guard defensively) return it as-is.
  if (Array.isArray(raw)) {
    console.warn("[secure-auth-store] Found unencrypted users in secure-users.json — re-encrypting.");
    await writeUserRecords(raw);
    return raw;
  }

  // secure-users.json absent: check legacy users.json for migration
  const legacy = await readStore<User[]>(LEGACY_USERS_FILE, []);
  if (legacy.length > 0) {
    try {
      await writeUserRecords(legacy);
      console.log(`[secure-auth-store] Migrated ${legacy.length} user record(s) to encrypted storage.`);
    } catch (err) {
      console.error(
        "[secure-auth-store] Migration encrypt failed:",
        err instanceof Error ? err.message : err
      );
      // Return legacy plaintext as a fallback — better than losing access
    }
  }
  return legacy;
}

/**
 * Encrypt and persist the user records array.
 * Always uses strong durability — user mutations must survive cold starts.
 */
export async function writeUserRecords(users: User[]): Promise<void> {
  const envelope = encrypt(JSON.stringify(users));
  await writeStore(SECURE_USERS_FILE, envelope, undefined, { durability: "strong" });
}

// ── Reset token record storage ────────────────────────────────────────────────

/**
 * Read the encrypted reset token records array.
 * Returns [] if no file exists (fresh install or all tokens expired/consumed).
 *
 * Legacy password-reset-tokens.json is intentionally NOT migrated — see doc.
 */
export async function readResetTokenRecords(): Promise<HashedResetToken[]> {
  const raw = await readStore<EncryptedEnvelope | HashedResetToken[] | null>(
    SECURE_RESET_TOKENS_FILE,
    null
  );

  if (raw !== null && isEnvelope(raw)) {
    try {
      return JSON.parse(decrypt(raw)) as HashedResetToken[];
    } catch (err) {
      console.error(
        "[secure-auth-store] Failed to decrypt reset token records:",
        err instanceof Error ? err.message : err
      );
      return [];
    }
  }

  if (Array.isArray(raw)) {
    // Shouldn't happen, but re-encrypt defensively
    await writeResetTokenRecords(raw);
    return raw;
  }

  // No file → empty (also covers the case where legacy tokens are intentionally invalidated)
  return [];
}

/**
 * Encrypt and persist the reset token records array.
 * Uses strong durability so tokens survive between cold starts.
 */
export async function writeResetTokenRecords(records: HashedResetToken[]): Promise<void> {
  const envelope = encrypt(JSON.stringify(records));
  await writeStore(SECURE_RESET_TOKENS_FILE, envelope, undefined, { durability: "strong" });
}
