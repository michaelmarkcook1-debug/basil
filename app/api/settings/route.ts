import { NextResponse } from "next/server";
import { getSettings, patchSettings } from "@/lib/settings/store";
import { getSessionUser } from "@/lib/auth";
import { findByUsername } from "@/lib/users";
import {
  saveSettingsSecret,
  listConfiguredSettingsSecrets,
  SETTINGS_SECRET_KEYS,
  type SettingsSecretKey,
} from "@/lib/storage/secure-settings-store";
import type { UserSettings } from "@/lib/settings/store";

/**
 * GET /api/settings — returns safe settings for the current user.
 *
 * Sensitive fields (githubToken, openaiApiKey) are NEVER returned in the
 * response. Instead, boolean "configured" flags indicate whether each secret
 * is set, so the UI can show appropriate connect/disconnect controls without
 * ever receiving the raw secret values.
 */
export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const [settings, user, secretFlags] = await Promise.all([
    getSettings(username),
    findByUsername(username),
    listConfiguredSettingsSecrets(username),
  ]);

  return NextResponse.json({
    ...settings,
    username,
    onboardingCompleted:    user?.onboardingCompleted ?? false,
    profile:                user?.profile ?? {},
    // Safe boolean flags — never the raw secret values
    githubTokenConfigured:  secretFlags.githubToken,
    openaiApiKeyConfigured: secretFlags.openaiApiKey,
  });
}

/**
 * PATCH /api/settings — writes a partial update for the current user.
 *
 * Non-sensitive fields are written to sage-settings.json via patchSettings().
 * Sensitive fields (githubToken, openaiApiKey) are intercepted here and
 * written to the encrypted secure-settings-store instead.
 *   - Non-empty string value → encrypt and save
 *   - Empty string ("") → delete the secret (disconnect)
 *
 * Returns the full updated safe settings object (no raw secret values).
 */
export async function PATCH(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  let body: Partial<UserSettings & Record<SettingsSecretKey, string>>;
  try {
    body = (await req.json()) as Partial<UserSettings & Record<SettingsSecretKey, string>>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    // ── Handle sensitive secret fields ──────────────────────────────────────
    // Process in parallel; each key is independently encrypted.
    const secretOps = SETTINGS_SECRET_KEYS
      .filter((k) => k in body)
      .map((k) => saveSettingsSecret(username, k, body[k] ?? null));
    if (secretOps.length > 0) await Promise.all(secretOps);

    // ── Handle non-sensitive settings ───────────────────────────────────────
    const updated = await patchSettings(username, body);

    // Return safe settings + current configured flags (secret may have changed)
    const secretFlags = await listConfiguredSettingsSecrets(username);
    return NextResponse.json({
      ...updated,
      githubTokenConfigured:  secretFlags.githubToken,
      openaiApiKeyConfigured: secretFlags.openaiApiKey,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Update failed";
    console.error("[api/settings] PATCH failed:", message);
    const isValidationError = message.startsWith("Invalid ");
    return NextResponse.json(
      { error: message },
      { status: isValidationError ? 400 : 500 }
    );
  }
}
