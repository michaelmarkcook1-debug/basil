/**
 * Persistent store for Michael's profile / assistant-configuration settings.
 *
 * Previously these values were hardcoded in two places:
 *   - app/dashboard/settings/page.tsx   (display)
 *   - lib/ai/system-prompt.ts           (AI context)
 *
 * Now they live in the server store.  The system prompt reads them at call
 * time; the settings UI reads and writes them through /api/settings.
 *
 * All fields have defaults so the system works on a fresh deploy with no
 * prior configuration.  Partial patches are fine — only the supplied keys
 * are overwritten.
 */

import { readStore, writeStore } from "@/lib/storage/persistent";

const SETTINGS_FILE = "sage-settings.json";

export interface UserSettings {
  /** Display name used in external communications and the system prompt. */
  name: string;
  /** IANA timezone string, e.g. "Europe/London". */
  timezone: string;
  /** Work-day start in HH:MM (24-hour, local time), e.g. "12:00". */
  workStart: string;
  /** Work-day end in HH:MM (24-hour, local time), e.g. "20:00". */
  workEnd: string;
  /** Preferred video-call tool, e.g. "Zoom". */
  videoTool: string;
  /** Full Zoom (or other) room URL — included in calendar invites and the system prompt. */
  meetingUrl: string;
}

/** Production defaults — match the previously-hardcoded values exactly. */
const DEFAULTS: UserSettings = {
  name:       "Michael Cook",
  timezone:   "Europe/London",
  workStart:  "12:00",
  workEnd:    "20:00",
  videoTool:  "Zoom",
  meetingUrl: "https://us06web.zoom.us/j/8588489477?pwd=p5SrgLfrDLBXKCvbFOFGGfMaoQ1MkI.1",
};

// ── Validation helpers ─────────────────────────────────────────────────────

/**
 * Returns true if `tz` is a valid IANA timezone identifier.
 *
 * Uses Intl.DateTimeFormat as the authoritative source — it internally validates
 * against the Unicode CLDR timezone list. Any invalid string throws RangeError.
 *
 * Examples of valid values: "Europe/London", "America/New_York", "UTC", "Asia/Tokyo".
 * Examples of invalid values: "London", "EST", "GMT+5", "America/NewYork".
 */
export function isValidIANATimezone(tz: string): boolean {
  if (!tz || typeof tz !== "string") return false;
  try {
    // Intl.DateTimeFormat throws RangeError for invalid timezone identifiers.
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Returns the stored settings merged over defaults (partial stores are safe). */
export async function getSettings(): Promise<UserSettings> {
  const stored = await readStore<Partial<UserSettings>>(SETTINGS_FILE, {});
  return { ...DEFAULTS, ...stored };
}

/**
 * Writes a partial update and returns the full resulting settings object.
 * Unknown keys in `patch` are silently ignored — only `UserSettings` fields
 * are persisted.
 */
export async function patchSettings(
  patch: Partial<UserSettings>
): Promise<UserSettings> {
  const current = await getSettings();
  // Allow only known keys through so rogue POST bodies can't inject arbitrary data.
  // Validate timezone before persisting — an invalid IANA string will
  // break every Intl.DateTimeFormat call in briefing/digest rendering.
  if (patch.timezone !== undefined && !isValidIANATimezone(patch.timezone)) {
    throw new Error(
      `Invalid timezone: "${patch.timezone}". ` +
      `Must be a valid IANA timezone identifier (e.g. "Europe/London", "America/New_York", "UTC").`
    );
  }

  const safe: Partial<UserSettings> = {};
  const keys: Array<keyof UserSettings> = [
    "name", "timezone", "workStart", "workEnd", "videoTool", "meetingUrl",
  ];
  for (const k of keys) {
    if (patch[k] !== undefined) safe[k] = patch[k] as string;
  }
  const updated: UserSettings = { ...current, ...safe };
  await writeStore(SETTINGS_FILE, updated);
  return updated;
}
