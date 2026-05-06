/**
 * lib/storage/crypto.ts — shared AES-256-GCM helpers.
 *
 * Used by both secure-token-store (OAuth tokens) and secure-auth-store
 * (user records, password reset tokens).
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
 * IMPORTANT: This module must never be imported by client components.
 */

import "server-only";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

// ── Constants ────────────────────────────────────────────────────────────────

export const ALGORITHM = "aes-256-gcm";
export const KEY_BYTES = 32; // 256 bits
export const IV_BYTES  = 12; // 96-bit IV — standard for GCM
export const TAG_BYTES = 16; // 128-bit auth tag

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
    typeof (obj as Record<string, unknown>).iv === "string" &&
    typeof (obj as Record<string, unknown>).tag === "string" &&
    typeof (obj as Record<string, unknown>).data === "string"
  );
}

// ── Encryption key ────────────────────────────────────────────────────────────

// CI dummy key: 32 bytes of 0x42 — NOT safe for production
const CI_DUMMY_KEY = Buffer.alloc(KEY_BYTES, 0x42);

export function getEncryptionKey(): Buffer {
  const raw = process.env.BASIL_TOKEN_ENCRYPTION_KEY;

  if (!raw) {
    if (process.env.NODE_ENV === "test" || process.env.CI === "true") {
      return CI_DUMMY_KEY;
    }
    throw new Error(
      "[crypto] BASIL_TOKEN_ENCRYPTION_KEY is not set. " +
      "Set a 64-character hex key (32 bytes) in your environment variables. " +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }

  const key = Buffer.from(raw, "hex");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `[crypto] BASIL_TOKEN_ENCRYPTION_KEY must be ${KEY_BYTES * 2} hex characters ` +
      `(${KEY_BYTES} bytes). Got ${key.length} bytes.`
    );
  }
  return key;
}

// ── Encrypt / decrypt ─────────────────────────────────────────────────────────

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

export function decrypt(envelope: EncryptedEnvelope): string {
  const key        = getEncryptionKey();
  const iv         = Buffer.from(envelope.iv, "hex");
  const tag        = Buffer.from(envelope.tag, "hex");
  const ciphertext = Buffer.from(envelope.data, "hex");

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}
