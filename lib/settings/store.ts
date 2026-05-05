/**
 * Per-user assistant-configuration settings.
 *
 * Each user's settings live at  DATA_DIR/users/<username>/sage-settings.json
 * so their profile, timezone, and preferences are fully isolated.
 *
 * New users automatically get defaults derived from their username —
 * they are never addressed as another user's name.
 */

import { readUserStore, writeUserStore } from "@/lib/storage/user-store";

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
  /**
   * When true, Basil detects the user's timezone from their IP address on each request
   * (via Vercel's x-vercel-ip-timezone header) and uses that instead of the stored
   * `timezone` field for calendar date boundaries and the system prompt.
   * Falls back to `timezone` if the IP lookup fails.
   */
  useIpTimezone?: boolean;
  /** GitHub Personal Access Token for syncing repositories in AI Projects. */
  githubToken?: string;
  /** OpenAI API key for syncing Assistants threads in AI Projects. */
  openaiApiKey?: string;
}

/** Base defaults — used as fallback for any unset field. */
const BASE_DEFAULTS: Omit<UserSettings, "name"> = {
  timezone:      "Europe/London",
  workStart:     "09:00",
  workEnd:       "18:00",
  videoTool:     "Zoom",
  meetingUrl:    "",
  useIpTimezone: false,
};

/**
 * Returns user-specific defaults.
 * The display name is derived from the username so new users are never
 * addressed as a different user.
 */
function defaultsForUser(username: string): UserSettings {
  // "michael_cook" → "Michael Cook", "alice" → "Alice"
  const displayName = username
    .replace(/[_.-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return { name: displayName, ...BASE_DEFAULTS };
}

// ── Validation helpers ─────────────────────────────────────────────────────

/**
 * Returns true if `tz` is a valid IANA timezone identifier.
 */
export function isValidIANATimezone(tz: string): boolean {
  if (!tz || typeof tz !== "string") return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Returns the stored settings for this user, merged over their defaults. */
export async function getSettings(username: string): Promise<UserSettings> {
  const stored = await readUserStore<Partial<UserSettings>>(username, SETTINGS_FILE, {});
  return { ...defaultsForUser(username), ...stored };
}

/**
 * Writes a partial update for this user and returns the full resulting settings.
 * Unknown keys in `patch` are silently ignored.
 */
export async function patchSettings(
  username: string,
  patch: Partial<UserSettings>
): Promise<UserSettings> {
  const current = await getSettings(username);

  if (patch.timezone !== undefined && !isValidIANATimezone(patch.timezone)) {
    throw new Error(
      `Invalid timezone: "${patch.timezone}". ` +
      `Must be a valid IANA timezone identifier (e.g. "Europe/London", "America/New_York", "UTC").`
    );
  }

  const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (patch.workStart !== undefined && !HH_MM.test(patch.workStart)) {
    throw new Error(`Invalid workStart: "${patch.workStart}". Must be HH:MM in 24-hour format (e.g. "09:00").`);
  }
  if (patch.workEnd !== undefined && !HH_MM.test(patch.workEnd)) {
    throw new Error(`Invalid workEnd: "${patch.workEnd}". Must be HH:MM in 24-hour format (e.g. "18:00").`);
  }

  const safe: Partial<UserSettings> = {};
  const keys: Array<keyof UserSettings> = [
    "name", "timezone", "workStart", "workEnd", "videoTool", "meetingUrl", "useIpTimezone", "githubToken", "openaiApiKey",
  ];
  for (const k of keys) {
    if (patch[k] !== undefined) {
      // useIpTimezone is boolean; all other keys are strings
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (safe as any)[k] = patch[k];
    }
  }
  const updated: UserSettings = { ...current, ...safe };
  await writeUserStore(username, SETTINGS_FILE, updated);
  return updated;
}
