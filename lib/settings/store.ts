/**
 * Per-user assistant-configuration settings.
 *
 * Each user's settings live at  DATA_DIR/users/<username>/sage-settings.json
 * so their profile, timezone, and preferences are fully isolated.
 *
 * New users automatically get defaults derived from their username —
 * they are never addressed as another user's name.
 */

import { HOLIDAY_REGIONS, type HolidayRegion } from "@/lib/away/calendar";
import { readUserStore, updateUserStore } from "@/lib/storage/user-store";

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
  /**
   * The user's OWN LinkedIn profile URL.
   *
   * Not cosmetic. Signature harvesting reads the sender's profile out of a mail
   * body, and a reply quotes the user's own signature beneath the sender's — so
   * without knowing which slug is the user's, a reply from someone who has no
   * LinkedIn of their own yields exactly one profile (the user's) and attaches
   * it to them. Knowing it also RECOVERS yield: a reply carrying both profiles
   * is currently discarded as ambiguous, and excluding the user's leaves
   * precisely one — the sender's.
   */
  linkedin?: string;
  /** GitHub Personal Access Token for syncing repositories in AI Projects. */
  githubToken?: string;
  /** OpenAI API key for syncing AI projects. Legacy storage — new saves use secure-token-store. */
  openaiApiKey?: string;
  /** Anthropic API key. Legacy storage — new saves use secure-token-store. */
  anthropicApiKey?: string;
  /** Gemini API key. Legacy storage — new saves use secure-token-store. */
  geminiApiKey?: string;
  /**
   * Slack contacts / channels to pin at the top of the signals feed.
   * Each entry is a name string:
   *  - Single name (e.g. "Alice") → DM with that person
   *  - "+" separated (e.g. "Alice + Bob") → group DM with those people
   *  - "#channel" → pin a Slack channel
   * Defaults to empty (no pins) so new users don't see someone else's contacts.
   */
  pinnedSlackContacts?: string[];
  /** Deliver the daily briefing by email (default on when an email exists). */
  briefingEmail?: boolean;
  /** Deliver the daily briefing as a Slack DM (opt-in, default off). */
  briefingSlack?: boolean;
  /**
   * Read how each relationship feels (tone, trend, shifts) from message history.
   * Default on. Off stops the model reads and the per-message tone shifts, and
   * hides tone everywhere; stored reads are kept but not shown.
   */
  toneSentiment?: boolean;
  /**
   * Days of the week the user works, 0 = Sunday … 6 = Saturday. Unset means
   * Monday to Friday. No briefing is written on other days and the follow-up
   * clocks do not count them (lib/away/calendar.ts).
   */
  workingDays?: number[];
  /** Bank holidays to treat as days off. Unset: England and Wales for Europe/London, otherwise none. */
  holidayRegion?: HolidayRegion;
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
  // "jordan_avery" → "Jordan Avery", "alice" → "Alice"
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
 *
 * Validation runs first, then the merge happens inside updateUserStore — under
 * the per-file lock, on a FRESH read. This used to read through getSettings
 * (the per-instance /tmp cache) and write the whole record back unlocked, so
 * saving one setting could revert another changed moments earlier on another
 * instance (2026-11-10 bug pass, C2).
 */
export async function patchSettings(
  username: string,
  patch: Partial<UserSettings>
): Promise<UserSettings> {
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
  if (patch.workingDays !== undefined) {
    const days = patch.workingDays;
    if (!Array.isArray(days) || days.length === 0 || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
      throw new Error("Invalid workingDays: pick at least one day, as numbers 0 (Sunday) to 6 (Saturday).");
    }
    patch = { ...patch, workingDays: [...new Set(days)].sort() };
  }
  if (patch.holidayRegion !== undefined && !HOLIDAY_REGIONS.includes(patch.holidayRegion)) {
    throw new Error(`Invalid holidayRegion: "${patch.holidayRegion}". Use one of ${HOLIDAY_REGIONS.join(", ")}.`);
  }

  const safe: Partial<UserSettings> = {};
  const keys: Array<keyof UserSettings> = [
    "name", "timezone", "workStart", "workEnd", "videoTool", "meetingUrl", "useIpTimezone", "githubToken", "openaiApiKey", "anthropicApiKey", "geminiApiKey", "pinnedSlackContacts",
    "briefingEmail", "briefingSlack", "toneSentiment", "workingDays", "holidayRegion",
  ];
  for (const k of keys) {
    if (patch[k] !== undefined) {
      // useIpTimezone is boolean; all other keys are strings
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (safe as any)[k] = patch[k];
    }
  }
  const defaults = defaultsForUser(username);
  const stored = await updateUserStore<Partial<UserSettings>>(
    username,
    SETTINGS_FILE,
    // Same record shape as before: defaults, then what is stored, then the patch.
    (current) => ({ ...defaults, ...(current ?? {}), ...safe }),
    {},
  );
  return { ...defaults, ...stored };
}
