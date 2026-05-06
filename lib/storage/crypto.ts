/**
 * lib/storage/crypto.ts — server-only AES-256-GCM encryption helpers.
 *
 * Shared by secure-token-store.ts and secure-settings-store.ts.
 * Never import this from client components.
 *
 * Encryption key: BASIL_TOKEN_ENCRYPTION_KEY (64 hex chars = 32 bytes).
 * - Production: key must be set or writes fail with a hard error.
 * - Test / CI (NODE_ENV=test or CI=true): deterministic dummy key used.
 */

import "server-only";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

// ── Constants ────────────────────────────────────────────────────────────────

export const ALGORITHM  = "aes-256-gcm";
export const KEY_BYTES  = 32; // 256 bits
export const IV_BYTES   = 12; // 96-bit IV — optimal for GCM
export const TAG_BYTES  = 16; // 128-bit auth tag

// ── Encrypted envelope ───────────────────────────────────────────────────────

export interface EncryptedEnvelope {
  v:    1;
  iv:   string; // hex
  tag:  string; // hex
  data: string; // hex (ciphertext)
}

export function isEnvelope(obj: unknown): obj is EncryptedEnvelope {
  return (
    typeof obj === "object" &&
    obj !== null &&
    (obj as Record<string, unknown>).v === 1 &&
    typeof (obj as Record<string, unknown>).iv   === "string" &&
    typeof (obj as Record<string, unknown>).tag  === "string" &&
    typeof (obj as Record<string, unknown>).data === "string"
  );
}

// ── Key resolution ────────────────────────────────────────────────────────────

// CI dummy key — 32 bytes of 0x42 — never safe for production use.
const CI_DUMMY_KEY = Buffer.alloc(KEY_BYTES, 0x42);

export function getEncryptionKey(): Buffer {
  const raw = process.env.BASIL_TOKEN_ENCRYPTION_KEY;

  if (!raw) {
    if (process.env.NODE_ENV === "test" || process.env.CI === "true") {
      return CI_DUMMY_KEY;
    }
    throw new Error(
      "[basil-crypto] BASIL_TOKEN_ENCRYPTION_KEY is not set. " +
      `Generate a key: node -e "console.log(require('crypto').randomBytes(${KEY_BYTES}).toString('hex'))"` +
      " and add it to your Vercel environment variables."
    );
  }

  const key = Buffer.from(raw, "hex");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `[basil-crypto] BASIL_TOKEN_ENCRYPTION_KEY must be ${KEY_BYTES * 2} hex characters ` +
      `(${KEY_BYTES} bytes). Got ${key.length} bytes.`
    );
  }
  return key;
}

// ── Encrypt / decrypt ─────────────────────────────────────────────────────────

/**
 * Encrypt a plaintext string and return an EncryptedEnvelope.
 * A fresh random IV is generated for every call.
 */
export function encrypt(plaintext: string): EncryptedEnvelope {
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

/**
 * Decrypt an EncryptedEnvelope back to the original plaintext string.
 * Throws if the auth tag doesn't match (tampered ciphertext) or the key is wrong.
 */
export function decrypt(envelope: EncryptedEnvelope): string {
  const key        = getEncryptionKey();
  const iv         = Buffer.from(envelope.iv,   "hex");
  const tag        = Buffer.from(envelope.tag,  "hex");
  const ciphertext = Buffer.from(envelope.data, "hex");

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}
