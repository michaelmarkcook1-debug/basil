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

import { findByUsername, updateUser } from "@/lib/users";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SelfIdentity {
  /** Lower-cased email addresses that belong to this user. */
  emails: string[];
  /** Lower-cased full-name strings that represent this user. */
  names: string[];
  /**
   * Other WHOLE names that always mean this user ("mike cook", "michael",
   * "mike c", "michael c"). Matched exactly, never by substring or first
   * word — "mike c" must not claim "Mike Collins". Kept apart from `names`
   * because many callers take the first word of each name.
   */
  aliases?: string[];
  /**
   * Bare nicknames ("mike") that mean this user only in context: when the
   * text does not also mention them by first name ("Michael") or name another
   * person with that nickname. See `selfInContext`.
   */
  nicknames?: string[];
}

/** Common short forms of first names. A bare nickname is context-dependent (another Mike may be present). */
const NICKNAMES: Record<string, string[]> = {
  michael: ["mike", "mick"], william: ["will", "bill"], robert: ["rob", "bob"],
  james: ["jim", "jamie"], richard: ["rich", "rick"], thomas: ["tom"], daniel: ["dan"],
  christopher: ["chris"], matthew: ["matt"], andrew: ["andy", "drew"], joseph: ["joe"],
  edward: ["ed"], alexander: ["alex"], benjamin: ["ben"], nicholas: ["nick"],
  jonathan: ["jon"], samuel: ["sam"], stephen: ["steve"], steven: ["steve"],
  elizabeth: ["liz", "beth"], katherine: ["kate", "kath"], catherine: ["cat", "kate"],
  jennifer: ["jen", "jenny"], rebecca: ["becky", "becca"], margaret: ["maggie"],
  victoria: ["vicky"], alexandra: ["alex"], samantha: ["sam"],
};

/**
 * The forms a person's name takes in meeting notes: first name alone, first
 * name + surname initial, and each nickname + surname / + initial. Pure.
 */
export function nameForms(first: string, surname: string): { aliases: string[]; nicknames: string[] } {
  const f = first.trim().toLowerCase();
  const s = surname.trim().toLowerCase();
  if (!f) return { aliases: [], nicknames: [] };
  const nicks = NICKNAMES[f] ?? [];
  const aliases = new Set<string>([f]);
  if (s) {
    aliases.add(`${f} ${s[0]}`);
    for (const n of nicks) { aliases.add(`${n} ${s}`); aliases.add(`${n} ${s[0]}`); }
  }
  return { aliases: [...aliases], nicknames: [...nicks] };
}

const escRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** First-name forms of anyone: "Mike Trujillo" → ["mike"], "Michael Smith" → ["michael", "mike", "mick"]. */
export function firstNameForms(fullName: string): string[] {
  const f = fullName.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return f ? [f, ...(NICKNAMES[f] ?? [])] : [];
}

/**
 * Identity for one meeting: does a bare nickname ("Mike") mean the user here?
 *
 *  - Not if the notes also call the user by first name ("…send Michael the
 *    numbers" — then Mike is someone else), or name a Mike with another surname.
 *  - If the user knows another person who goes by that name (a contact, e.g.
 *    Mike Trujillo), only when the participant list is known and he is not on
 *    it. With no participant list (the digest), it stays as written: filing a
 *    colleague's task as the user's is worse than leaving the user's as "Mike".
 *  - Otherwise, yes.
 */
export function selfInContext(
  identity: SelfIdentity,
  text: string,
  ctx: { otherPeople?: string[]; attendees?: string[] } = {},
): SelfIdentity {
  const nicks = identity.nicknames ?? [];
  if (!nicks.length || !text) return identity;
  const first = identity.names[0]?.split(/\s+/)[0];
  const surname = identity.names[0]?.split(/\s+/).slice(1).join(" ");
  if (first && new RegExp(`\\b${escRe(first)}\\b`, "i").test(text)) return identity;
  const others = (ctx.otherPeople ?? []).filter((p) => !isSelf(p, identity));
  const mine = nicks.filter((n) => {
    if (!new RegExp(`\\b${escRe(n)}\\b`, "i").test(text)) return false;
    // "Mike Smith" anywhere → another Mike is on the call.
    const cap = n[0].toUpperCase() + n.slice(1);
    const other = new RegExp(`\\b${escRe(cap)}\\s+([A-Z][a-z]+)`, "g");
    for (const m of text.matchAll(other)) {
      const sn = m[1].toLowerCase();
      if (surname && (sn === surname || surname.startsWith(sn))) continue;
      if (/^(will|to|and|or|is|was|has|had|said|asked|the|from|for|with|on|at|in)$/.test(sn)) continue;
      return false;
    }
    const namesakes = others.filter((p) => firstNameForms(p).includes(n));
    if (!namesakes.length) return true;
    const present = (ctx.attendees ?? []).filter((a) => a.trim() && !isSelf(a, identity));
    if (!present.length) return false;
    return !present.some((a) => firstNameForms(a).includes(n));
  });
  return mine.length ? { ...identity, aliases: [...(identity.aliases ?? []), ...mine] } : identity;
}

/** The user's display name, "Michael Cook" — what self-owned actions are filed under. */
export function canonicalSelfName(identity: SelfIdentity): string | undefined {
  const n = identity.names[0];
  return n ? n.replace(/\b\w/g, (c) => c.toUpperCase()) : undefined;
}

/** An owner that is the user under another name ("Mike Cook", "Mike C") → their display name. */
export function normaliseOwner(owner: string | undefined, identity: SelfIdentity): string | undefined {
  if (!owner?.trim()) return owner;
  const canon = canonicalSelfName(identity);
  return canon && isSelf(owner, identity) ? canon : owner;
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

    // Alias / send-as addresses the user owns (e.g. michael@analystgenius.ai
    // delivering to the same inbox). Treating them as self stops alias mail from
    // surfacing as a stranger, a phantom contact, or a "reply to yourself".
    for (const alias of user.aliasEmails ?? []) {
      const a = alias?.trim().toLowerCase();
      if (a) emails.push(a);
    }

    const fullName = [user.name, user.surname]
      .map((s) => s?.trim() ?? "")
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (fullName) names.push(fullName);
    const { aliases, nicknames } = nameForms(user.name ?? "", user.surname ?? "");

    return { emails, names, aliases: aliases.filter((a) => a !== fullName), nicknames };
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
  const bare = s.replace(/[.,]/g, "").replace(/\s+/g, " ");
  if (identity.aliases?.some((a) => bare === a)) return true;
  return false;
}

/**
 * Remove the user's own identifiers from a list of attendee email/name strings.
 */
export function stripSelf(list: string[], identity: SelfIdentity): string[] {
  return list.filter((x) => !isSelf(x, identity));
}

/**
 * Remember an address the user just connected (their work Gmail when they sign
 * in to Basil with a personal one) as their own, so mail from it is never
 * treated as a stranger, a phantom contact or a reply owed. Idempotent; never throws.
 */
export async function rememberOwnAddress(username: string, address: string | null | undefined): Promise<boolean> {
  const a = address?.trim().toLowerCase();
  if (!a || !a.includes("@")) return false;
  try {
    const user = await findByUsername(username);
    if (!user) return false;
    const known = [user.email, ...(user.aliasEmails ?? [])].map((e) => e?.trim().toLowerCase());
    if (known.includes(a)) return false;
    await updateUser(username, { aliasEmails: [...(user.aliasEmails ?? []), a] });
    return true;
  } catch (e) {
    console.warn("[self-identity] could not remember connected address:", e instanceof Error ? e.message : e);
    return false;
  }
}

