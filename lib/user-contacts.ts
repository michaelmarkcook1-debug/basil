// User-added contacts (stubs added via the "Suggested" strip on the Contacts
// page) live in localStorage so Michael can flesh them out without editing
// source. They share the Contact shape from contacts-data.ts and are merged
// with the seed contacts everywhere the app uses `contacts`.

import type { Contact } from "./contacts-data";

const USER_CONTACTS_KEY = "sage-user-contacts";
const DISMISSED_SUGGESTIONS_KEY = "sage-dismissed-suggestions";

/**
 * Back-compat: older records don't have a `directory` field. Default them to
 * "work" so the existing contacts stay visible after the Work/Personal split.
 */
function normalize(c: Contact): Contact {
  if (!c.directory) return { ...c, directory: "work" };
  return c;
}

export function getUserContacts(): Contact[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(USER_CONTACTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Contact[]) : [];
    return parsed.map(normalize);
  } catch {
    return [];
  }
}

export function addUserContact(c: Contact): void {
  if (typeof window === "undefined") return;
  const existing = getUserContacts();
  if (existing.some((x) => x.id === c.id)) return;
  localStorage.setItem(
    USER_CONTACTS_KEY,
    JSON.stringify([...existing, normalize(c)])
  );
}

/**
 * Patch an existing user-added contact. Returns true if the contact was found
 * and updated, false if no match. Seed contacts can't be updated here — those
 * live in source.
 */
export function updateUserContact(
  id: string,
  patch: Partial<Contact>
): boolean {
  if (typeof window === "undefined") return false;
  const existing = getUserContacts();
  const idx = existing.findIndex((c) => c.id === id);
  if (idx === -1) return false;
  existing[idx] = normalize({ ...existing[idx], ...patch });
  localStorage.setItem(USER_CONTACTS_KEY, JSON.stringify(existing));
  return true;
}

export function getDismissedSuggestionIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(DISMISSED_SUGGESTIONS_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function dismissSuggestion(id: string): void {
  if (typeof window === "undefined") return;
  const existing = getDismissedSuggestionIds();
  if (existing.includes(id)) return;
  localStorage.setItem(
    DISMISSED_SUGGESTIONS_KEY,
    JSON.stringify([...existing, id])
  );
}

/** Stable ID from a display name or email string — used as Contact.id. */
export function slugifyId(source: string): string {
  return source
    .toLowerCase()
    .replace(/@.*$/, "") // drop email domain
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Pick a tailwind bg- color from a deterministic name hash. */
export function pickAvatarColor(name: string): string {
  const palette = [
    "bg-blue-600",
    "bg-red-600",
    "bg-emerald-600",
    "bg-violet-600",
    "bg-amber-600",
    "bg-pink-600",
    "bg-cyan-600",
    "bg-orange-600",
    "bg-teal-600",
    "bg-indigo-600",
  ];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
