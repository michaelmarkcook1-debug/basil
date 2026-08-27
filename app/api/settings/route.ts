import { NextResponse } from "next/server";
import { z } from "zod";
import { getSettings, patchSettings } from "@/lib/settings/store";
import { getSessionUser, SKIP_AUTH } from "@/lib/auth";
import { findByUsername, updateUser } from "@/lib/users";
import { parseBody, apiError } from "@/lib/api/respond";

/** Type-validates the patchable settings fields (semantic checks remain in patchSettings). */
const SettingsPatchSchema = z.object({
  name: z.string().max(200).optional(),
  timezone: z.string().max(100).optional(),
  workStart: z.string().max(10).optional(),
  workEnd: z.string().max(10).optional(),
  videoTool: z.string().max(100).optional(),
  meetingUrl: z.string().max(500).optional(),
  useIpTimezone: z.boolean().optional(),
  /**
   * The user's own LinkedIn profile. Validated to a personal /in/ URL rather
   * than accepted as free text: a company or post URL stored here would be
   * excluded from harvesting as though it were the user, silently suppressing
   * a real contact's profile. Empty string clears it.
   */
  linkedin: z
    .string()
    .max(300)
    .refine(
      (v) => v === "" || /linkedin\.com\/in\/[A-Za-z0-9\-_%À-ÿ.]{2,100}/i.test(v),
      { message: "Must be a LinkedIn personal profile URL (linkedin.com/in/…)" },
    )
    .optional(),
  githubToken: z.string().max(500).optional(),
  openaiApiKey: z.string().max(500).optional(),
  anthropicApiKey: z.string().max(500).optional(),
  geminiApiKey: z.string().max(500).optional(),
  pinnedSlackContacts: z.array(z.string().max(200)).max(100).optional(),
  briefingEmail: z.boolean().optional(),
  briefingSlack: z.boolean().optional(),
  // Email aliases / send-as addresses (stored on the user record, not settings).
  aliasEmails: z.array(z.string().email().max(320)).max(20).optional(),
});

/** GET /api/settings — returns the full UserSettings object for the current user,
 *  extended with onboardingCompleted and profile fields from the user record. */
export async function GET() {
  const username = (await getSessionUser());
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const [settings, user] = await Promise.all([getSettings(username), findByUsername(username)]);
  return NextResponse.json({
    ...settings,
    username,
    email: user?.email ?? "",
    aliasEmails: user?.aliasEmails ?? [],
    onboardingCompleted: SKIP_AUTH ? true : (user?.onboardingCompleted ?? false),
    profile: user?.profile ?? {},
  });
}

/**
 * PATCH /api/settings — writes a partial update for the current user.
 * Body: Partial<UserSettings> — only the supplied keys are changed.
 * Returns the full updated settings object.
 */
export async function PATCH(req: Request) {
  const username = (await getSessionUser());
  if (!username) return apiError("Unauthorised", "unauthorized", 401);

  const parsed = await parseBody(req, SettingsPatchSchema);
  if (!parsed.ok) return parsed.response;

  try {
    // aliasEmails live on the user record (read by getSelfIdentity), not the
    // settings store — split them out and persist via updateUser.
    const { aliasEmails, ...settingsPatch } = parsed.data;
    if (aliasEmails !== undefined) {
      const normalized = Array.from(
        new Set(aliasEmails.map((a) => a.trim().toLowerCase()).filter(Boolean))
      );
      await updateUser(username, { aliasEmails: normalized });
    }
    const updated = await patchSettings(username, settingsPatch);
    const user = await findByUsername(username);
    return NextResponse.json({ ...updated, aliasEmails: user?.aliasEmails ?? [] });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Update failed";
    console.error("[api/settings] PATCH failed:", message);
    const isValidationError = message.startsWith("Invalid ");
    return apiError(message, isValidationError ? "invalid_settings" : "internal_error", isValidationError ? 400 : 500);
  }
}
