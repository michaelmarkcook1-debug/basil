/**
 * User-scoped self-identity helpers.
 *
 * When processing external signals (emails, calendar events, Slack messages)
 * we need to strip the user themselves — they are the owner, not an external
 * correspondent or meeting attendee.
 *
 * Identity is resolved from the authenticated user's own record (email + full
 * name). There are no hardcoded personal identifiers; every caller must supply
 * the owning username so identity is always user-scoped.
 */

import { findByUsername } from "@/lib/users";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SelfIdentity {
  /** Lower-cased email addresses that belong to this user. */
  emails: string[];
  /** Lower-cased full-name strings that represent this user. */
  names: string[];
}

// ── Core resolver ─────────────────────────────────────────────────────────────

/**
 * Resolve the user's own email(s) and display name(s) for self-filtering.
 *
 * Reads the user's registered email and name/surname from the user record.
 * Never falls back to hardcoded identifiers — returns empty arrays when
 * the user cannot be found so callers degrade gracefully (no filtering
 * beats wrong filtering).
 *
 * @param username  Required — the authenticated user owning this context.
 */
export async function getSelfIdentity(username: string): Promise<SelfIdentity> {
  if (!username) return { emails: [], names: [] };

  try {
    const user = await findByUsername(username);
    if (!user) return { emails: [], names: [] };

    const emails: string[] = [];
    const names: string[] = [];

    if (user.email?.trim()) {
      emails.push(user.email.trim().toLowerCase());
    }

    const fullName = [user.name, user.surname]
      .map((s) => s?.trim() ?? "")
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (fullName) names.push(fullName);

    return { emails, names };
  } catch {
    // Never throw — return an empty identity so callers don't crash
    return { emails: [], names: [] };
  }
}

// ── Predicate helpers ─────────────────────────────────────────────────────────

/**
 * True if the given string (email or display name) matches this user's identity.
 * Matching is case-insensitive and supports substring inclusion for display names.
 */
export function isSelf(
  identifier: string | undefined | null,
  identity: SelfIdentity
): boolean {
  if (!identifier) return false;
  const s = identifier.toLowerCase().trim();
  if (identity.emails.some((e) => s === e || s.includes(e))) return true;
  if (identity.names.some((n) => s === n || s.includes(n))) return true;
  return false;
}

/**
 * Remove the user's own identifiers from a list of attendee email/name strings.
 */
export function stripSelf(list: string[], identity: SelfIdentity): string[] {
  return list.filter((x) => !isSelf(x, identity));
}
