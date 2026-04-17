// Michael's own identity — everywhere we consume external signal we need to
// strip "Michael himself" so he doesn't get treated as a meeting attendee,
// an email correspondent, or a Slack interlocutor.
//
// Add any additional addresses he owns here. Matching is case-insensitive
// and checks for either exact email OR display-name substring.

// NOTE: mike@talentgenius.io is a DIFFERENT person at the company — do NOT
// list it here. Michael Cook is michael@talentgenius.io only.
export const SELF_EMAILS = [
  "michael@talentgenius.io",
];

export const SELF_NAMES = [
  "michael cook",
];

/** True if the given string (email or display name) represents Michael. */
export function isSelf(identifier: string | undefined | null): boolean {
  if (!identifier) return false;
  const s = identifier.toLowerCase().trim();
  if (SELF_EMAILS.some((e) => s === e || s.includes(e))) return true;
  if (SELF_NAMES.some((n) => s === n || s.includes(n))) return true;
  return false;
}

/** Remove Michael from a list of attendee identifiers (emails or names). */
export function stripSelf(list: string[]): string[] {
  return list.filter((x) => !isSelf(x));
}
