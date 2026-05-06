/**
 * secure-settings-store.ts — server-only, encrypted storage for sensitive
 * settings fields (API keys, tokens entered by the user in the Settings UI).
 *
 * Uses the same AES-256-GCM pattern as secure-token-store.ts.
 * All secrets are stored in a single per-user file:
 *   basil/users/<username>/secure-settings-secrets.json
 *
 * The file contains a map of:
 *   { [settingKey]: EncryptedEnvelope }
 *
 * Each envelope is independently encrypted so individual keys can be
 * read, written, or deleted without touching the rest.
 *
 * Supported secret keys:
 *   "githubToken", "openaiApiKey"
 *   (extend SETTINGS_SECRET_KEYS as new sensitive fields are added)
 *
 * Migration:
 *   On the first PATCH that touches a secret field, the server reads the
 *   legacy sage-settings.json, migrates any secret fields it finds into
 *   this store, and removes them from sage-settings.json.
 *   Reads always check the secure store first; the legacy plaintext value
 *   is only consulted during the migration pass itself.
 *
 * IMPORTANT: This module must never be imported by client components.
 */

import "server-only";
import { encrypt, decrypt, isEnvelope } from "@/lib/storage/crypto";
import type { EncryptedEnvelope } from "@/lib/storage/crypto";
import { readUserStore, writeUserStore } from "@/lib/storage/user-store";

// ── Supported secret setting keys ─────────────────────────────────────────────

export type SettingsSecretKey = "githubToken" | "openaiApiKey";

export const SETTINGS_SECRET_KEYS: SettingsSecretKey[] = [
  "githubToken",
  "openaiApiKey",
];

// ── Storage file ──────────────────────────────────────────────────────────────

const SECRETS_FILE = "secure-settings-secrets.json";

type SecretsMap = Partial<Record<SettingsSecretKey, EncryptedEnvelope>>;

async function readSecretsMap(username: string): Promise<SecretsMap> {
  return readUserStore<SecretsMap>(username, SECRETS_FILE, {});
}

async function writeSecretsMap(username: string, map: SecretsMap): Promise<void> {
  await writeUserStore(username, SECRETS_FILE, map);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Retrieve and decrypt a single settings secret.
 * Returns null if the key is not stored or decryption fails.
 *
 * Server-only: decrypted value must never be forwarded to client responses.
 */
export async function getSettingsSecret(
  username: string,
  key: SettingsSecretKey
): Promise<string | null> {
  const map = await readSecretsMap(username);
  const envelope = map[key];
  if (!isEnvelope(envelope)) return null;

  try {
    return decrypt(envelope);
  } catch (err) {
    console.error(
      `[secure-settings-store] Decryption failed for ${key}/${username}:`,
      err instanceof Error ? err.message : "unknown error"
    );
    return null;
  }
}

/**
 * Encrypt and store a settings secret.
 * Pass an empty string or null to delete the secret instead.
 * Throws if the encryption key is missing in production.
 */
export async function saveSettingsSecret(
  username: string,
  key: SettingsSecretKey,
  value: string | null | undefined
): Promise<void> {
  const map = await readSecretsMap(username);

  if (!value || value.trim() === "") {
    // Empty value = delete
    delete map[key];
  } else {
    map[key] = encrypt(value.trim());
  }

  await writeSecretsMap(username, map);
}

/**
 * Delete a single settings secret.
 */
export async function deleteSettingsSecret(
  username: string,
  key: SettingsSecretKey
): Promise<void> {
  return saveSettingsSecret(username, key, null);
}

/**
 * Returns a map of which secret keys are configured (true = set, false = not set).
 * Never returns the actual secret values.
 *
 * Safe to include in API responses.
 */
export async function listConfiguredSettingsSecrets(
  username: string
): Promise<Record<SettingsSecretKey, boolean>> {
  const map = await readSecretsMap(username);
  return {
    githubToken:   isEnvelope(map.githubToken),
    openaiApiKey:  isEnvelope(map.openaiApiKey),
  };
}

/**
 * Migrate legacy plaintext secrets from sage-settings.json into this store.
 *
 * Called by the settings API on read and write to ensure legacy users are
 * migrated transparently without requiring any action on their part.
 *
 * Returns true if any secrets were migrated.
 */
export async function migrateLegacySettingsSecrets(
  username: string,
  legacySettings: Record<string, unknown>
): Promise<{ migrated: boolean; cleaned: Record<string, unknown> }> {
  let migrated = false;
  const cleaned = { ...legacySettings };

  const map = await readSecretsMap(username);

  for (const key of SETTINGS_SECRET_KEYS) {
    const legacyValue = legacySettings[key];
    if (typeof legacyValue !== "string" || !legacyValue.trim()) continue;
    // Only migrate if the secure store doesn't already have this key
    if (isEnvelope(map[key])) {
      // Secure store already has it — just remove from legacy
      delete cleaned[key];
      migrated = true;
      continue;
    }
    // Encrypt and move to secure store
    try {
      map[key] = encrypt(legacyValue.trim());
      delete cleaned[key];
      migrated = true;
    } catch (err) {
      console.error(
        `[secure-settings-store] Migration encrypt failed for ${key}/${username}:`,
        err instanceof Error ? err.message : "unknown error"
      );
    }
  }

  if (migrated) {
    await writeSecretsMap(username, map);
  }

  return { migrated, cleaned };
}
