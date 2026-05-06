/**
 * secure-token-store.ts — server-only, encrypted, user-scoped OAuth token storage.
 *
 * All OAuth/integration tokens are encrypted with AES-256-GCM before being
 * written to the underlying storage backend (Vercel Blob via writeUserStore).
 * Even if the blob is publicly readable, the ciphertext is useless without the
 * server-side encryption key.
 *
 * Encryption: AES-256-GCM
 *   – 96-bit IV (12 bytes), fresh random per write
 *   – 256-bit key from BASIL_TOKEN_ENCRYPTION_KEY (64 hex chars)
 *   – 128-bit auth tag — protects against tampering
 *
 * Envelope format stored in JSON:
 *   { v: 1, iv: "<hex>", tag: "<hex>", data: "<hex>" }
 *
 * Key requirement:
 *   – Production: BASIL_TOKEN_ENCRYPTION_KEY must be set (64 hex chars)
 *   – Test / CI:  a deterministic dummy key is used if the var is absent
 *   – Missing key in production causes a hard server-side error (fail safe)
 *
 * Migration:
 *   On first read for a provider, if the encrypted file is absent but the
 *   legacy plaintext file exists, the plaintext tokens are migrated in-place
 *   (re-encrypted and stored in the new format, old file overwritten to null).
 *   Users never need to re-authenticate.
 *
 * IMPORTANT: This module must never be imported by client components.
 * It uses Node.js crypto and calls server-only storage helpers.
 */

import "server-only";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { readUserStore, writeUserStore } from "@/lib/storage/user-store";

// ── Constants ────────────────────────────────────────────────────────────────

const ALGORITHM   = "aes-256-gcm";
const KEY_BYTES   = 32; // 256 bits
const IV_BYTES    = 12; // 96-bit IV — standard for GCM
const TAG_BYTES   = 16; // 128-bit auth tag

// ── Supported providers ───────────────────────────────────────────────────────

export type SupportedProvider = "google" | "microsoft" | "slack" | "zoom" | "linear";

// Mapping from provider → legacy plaintext filename (for migration)
const LEGACY_FILES: Record<SupportedProvider, string> = {
  google:    "google-tokens.json",
  microsoft: "microsoft-tokens.json",
  slack:     "slack-config.json",
  zoom:      "zoom-tokens.json",
  linear:    "linear-config.json",
};

function secureFile(provider: SupportedProvider): string {
  return `secure-tokens-${provider}.json`;
}

// ── Encrypted envelope ───────────────────────────────────────────────────────

interface EncryptedEnvelope {
  v:    1;
  iv:   string; // hex
  tag:  string; // hex
  data: string; // hex (ciphertext)
}

function isEnvelope(obj: unknown): obj is EncryptedEnvelope {
  return (
    typeof obj === "object" &&
    obj !== null &&
    (obj as Record<string, unknown>).v === 1 &&
    typeof (obj as Record<string, unknown>).iv === "string" &&
    typeof (obj as Record<string, unknown>).tag === "string" &&
    typeof (obj as Record<string, unknown>).data === "string"
  );
}

// ── Encryption key ────────────────────────────────────────────────────────────

// CI dummy key: 32 bytes of 0x42 — NOT safe for production
const CI_DUMMY_KEY = Buffer.alloc(KEY_BYTES, 0x42);

function getEncryptionKey(): Buffer {
  const raw = process.env.BASIL_TOKEN_ENCRYPTION_KEY;

  if (!raw) {
    // Allow CI/test environments to proceed without a key — using a dummy
    if (process.env.NODE_ENV === "test" || process.env.CI === "true") {
      return CI_DUMMY_KEY;
    }
    // Production: fail hard — never store tokens unencrypted
    throw new Error(
      "[secure-token-store] BASIL_TOKEN_ENCRYPTION_KEY is not set. " +
      "Set a 64-character hex key (32 bytes) in your environment variables. " +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }

  const key = Buffer.from(raw, "hex");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `[secure-token-store] BASIL_TOKEN_ENCRYPTION_KEY must be ${KEY_BYTES * 2} hex characters ` +
      `(${KEY_BYTES} bytes). Got ${key.length} bytes.`
    );
  }
  return key;
}

// ── Encrypt / decrypt ─────────────────────────────────────────────────────────

function encrypt(plaintext: string): EncryptedEnvelope {
  const key    = getEncryptionKey();
  const iv     = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });

  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag       = cipher.getAuthTag();

  return {
    v:    1,
    iv:   iv.toString("hex"),
    tag:  tag.toString("hex"),
    data: encrypted.toString("hex"),
  };
}

function decrypt(envelope: EncryptedEnvelope): string {
  const key       = getEncryptionKey();
  const iv        = Buffer.from(envelope.iv, "hex");
  const tag       = Buffer.from(envelope.tag, "hex");
  const ciphertext = Buffer.from(envelope.data, "hex");

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

// ── Migration helper ──────────────────────────────────────────────────────────

/**
 * On first access for a provider, if the legacy plaintext file exists and the
 * secure file does not, migrate transparently: encrypt and write to secure file,
 * then null out the old plaintext file.
 *
 * Returns the migrated payload or null if no legacy data exists.
 */
async function tryMigrateLegacy<T>(
  username: string,
  provider: SupportedProvider
): Promise<T | null> {
  const legacyFile = LEGACY_FILES[provider];

  let legacy: T | null = null;
  try {
    legacy = await readUserStore<T | null>(username, legacyFile, null);
  } catch {
    return null;
  }

  // Nothing to migrate
  if (legacy === null || typeof legacy !== "object") return null;
  // Sanity: if legacy looks empty (e.g. {}) treat as nothing to migrate
  if (Object.keys(legacy as object).length === 0) return null;

  try {
    // Encrypt and save to secure file
    const plaintext = JSON.stringify(legacy);
    const envelope  = encrypt(plaintext);
    await writeUserStore(username, secureFile(provider), envelope);

    // Null out the legacy plaintext file so it no longer leaks tokens
    await writeUserStore(username, legacyFile, null);

    console.log(`[secure-token-store] Migrated legacy ${provider} tokens for ${username}`);
    return legacy;
  } catch (err) {
    console.error(
      `[secure-token-store] Migration failed for ${provider}/${username}:`,
      err instanceof Error ? err.message : err
    );
    // Return the plaintext anyway — better to work with unencrypted tokens
    // than to fail silently and force a re-auth on migration error
    return legacy;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Read and decrypt integration tokens for a user+provider pair.
 * Returns null if no tokens are stored (not connected) or if decryption fails.
 *
 * On first call for a given provider, attempts to migrate legacy plaintext tokens
 * to the encrypted format automatically.
 */
export async function getIntegrationToken<T>(
  username: string,
  provider: SupportedProvider
): Promise<T | null> {
  // Try the secure (encrypted) file first
  let envelope: unknown = null;
  try {
    envelope = await readUserStore<unknown>(username, secureFile(provider), null);
  } catch {
    // Storage error — treat as not connected
    return null;
  }

  if (isEnvelope(envelope)) {
    try {
      const plaintext = decrypt(envelope);
      return JSON.parse(plaintext) as T;
    } catch (err) {
      // Decryption failure — key may have rotated; force re-auth
      console.error(
        `[secure-token-store] Decryption failed for ${provider}/${username}:`,
        err instanceof Error ? err.message : "unknown error"
      );
      return null;
    }
  }

  // No secure file yet — attempt migration from legacy plaintext
  if (envelope === null) {
    return tryMigrateLegacy<T>(username, provider);
  }

  // File exists but isn't a valid envelope (e.g. null stored explicitly)
  return null;
}

/**
 * Encrypt and persist integration tokens for a user+provider pair.
 * Throws if the encryption key is missing in production.
 *
 * Never logs token values.
 */
export async function saveIntegrationToken(
  username:     string,
  provider:     SupportedProvider,
  tokenPayload: unknown
): Promise<void> {
  const plaintext = JSON.stringify(tokenPayload);
  const envelope  = encrypt(plaintext); // throws if key not configured
  await writeUserStore(username, secureFile(provider), envelope);
}

/**
 * Remove stored integration tokens for a user+provider pair.
 * Writes null to both the secure file and the legacy plaintext file to ensure
 * no stale unencrypted tokens remain.
 */
export async function deleteIntegrationToken(
  username: string,
  provider: SupportedProvider
): Promise<void> {
  // Clear secure file
  await writeUserStore(username, secureFile(provider), null);
  // Also clear legacy file in case migration hasn't run yet
  await writeUserStore(username, LEGACY_FILES[provider], null);
}

/**
 * Returns the list of providers for which this user has stored tokens.
 * Uses lightweight checks — does not decrypt or validate token freshness.
 */
export async function listConnectedProviders(username: string): Promise<SupportedProvider[]> {
  const providers: SupportedProvider[] = ["google", "microsoft", "slack", "zoom", "linear"];
  const checks = await Promise.all(
    providers.map(async (p) => {
      const token = await getIntegrationToken(username, p);
      return token !== null ? p : null;
    })
  );
  return checks.filter((p): p is SupportedProvider => p !== null);
}
