// User-added contacts — server store is authoritative; localStorage is a
// write-through cache for fast synchronous reads between server round-trips.
//
// Storage classification:
//   sage-user-contacts         → SERVER (domain truth, device-independent)
//                                Cached in localStorage after every server read/write.
//   sage-dismissed-suggestions → LOCAL-ONLY (per-device UX convenience — ephemeral)
//
// Write pattern: optimistic local update first → then persist to server.
// Read pattern: sync from cache (instant) + one async server fetch on page mount.

import type { Contact } from "./contacts-data";
import { emitChange } from "./sync/channel";

const USER_CONTACTS_KEY = "sage-user-contacts";
const DISMISSED_SUGGESTIONS_KEY = "sage-dismissed-suggestions";
/** Set once after the first successful migration push, never reset. */
const MIGRATION_KEY = "sage-user-contacts-migrated-v1";

// ── Internal helpers ──────────────────────────────────────────────────────────

function normalize(c: Contact): Contact {
  if (!c.directory) return { ...c, directory: "work" };
  return c;
}

// ── Synchronous cache reads ───────────────────────────────────────────────────

/**
 * Fast synchronous read from the localStorage cache.  Populated from the
 * server on page load via `loadUserContactsFromServer()`; falls back to an
 * empty array on first visit or SSR.
 */
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

/**
 * Replace a single contact in the localStorage cache with an authoritative
 * server-returned record.  Used after a PATCH succeeds so the cache reflects
 * the canonical server value immediately without a full re-fetch.
 *
 * Does NOT emit a domain-change event — callers that need cross-tab/surface
 * sync should call `emitChange("contacts")` separately.
 */
export function patchContactInCache(serverContact: Contact): void {
  if (typeof window === "undefined") return;
  const contacts = getUserContacts();
  const idx = contacts.findIndex((c) => c.id === serverContact.id);
  if (idx === -1) return;
  contacts[idx] = normalize(serverContact);
  try {
    localStorage.setItem(USER_CONTACTS_KEY, JSON.stringify(contacts));
  } catch { /* storage full */ }
}

/**
 * Synchronously merge contacts into the localStorage cache.
 * Used to seed the cache from a POST response body so subsequent reads
 * don't depend on a server round-trip that might hit a stale instance.
 */
export function mergeContactsIntoCache(incoming: Contact[]): void {
  if (typeof window === "undefined" || incoming.length === 0) return;
  const existing = getUserContacts();
  const existingIds = new Set(existing.map((c) => c.id));
  const brandNew = incoming
    .filter((c) => !existingIds.has(c.id))
    .map(normalize);
  if (brandNew.length === 0) return;
  localStorage.setItem(
    USER_CONTACTS_KEY,
    JSON.stringify([...existing, ...brandNew])
  );
}

// ── Server-authoritative async API ───────────────────────────────────────────

/**
 * Fetch all user contacts from the server store, update the localStorage
 * cache, and return the authoritative list.
 *
 * Also runs a one-time migration: any contacts already stored locally are
 * pushed to the server (idempotent — server skips existing IDs).
 */
export async function loadUserContactsFromServer(): Promise<Contact[]> {
  if (typeof window === "undefined") return [];

  // One-time migration: push existing localStorage contacts to the server store.
  if (!localStorage.getItem(MIGRATION_KEY)) {
    const cached = getUserContacts();
    if (cached.length > 0) {
      try {
        await fetch("/api/contacts/user", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ import: cached }),
        });
      } catch { /* migration is best-effort */ }
    }
    localStorage.setItem(MIGRATION_KEY, "1");
  }

  try {
    const res = await fetch("/api/contacts/user");
    if (!res.ok) return getUserContacts();
    const data = await res.json();
    const serverContacts = (data.contacts as Contact[]).map(normalize);
    const current = getUserContacts();

    // If the server returned nothing but localStorage has contacts, the server
    // instance is likely stale (BASIL_DATA hasn't propagated to it yet after a
    // recent import). Never overwrite a populated cache with an empty result —
    // that's the classic "contacts disappear seconds after import" bug.
    if (serverContacts.length === 0 && current.length > 0) {
      return current;
    }

    // Profile fields that are written optimistically by the client-side AI
    // profile generator.  On Vercel, PATCH calls for these can hit a warm
    // instance that hasn't yet picked up the latest BASIL_DATA, causing the
    // server to return "—" for fields that were successfully updated locally.
    // Rule: server wins when it has real data; local wins when server still
    // says "—" but local already has a generated value — never clobber good
    // local data with a stale-instance placeholder.
    const PROFILE_FIELDS = [
      "personality", "whatMakesThemTick", "watchOut", "recentActivity", "activitySource",
    ] as const;

    const localById = new Map(current.map((c) => [c.id, c]));
    const serverWithProfileProtection = serverContacts.map((sc) => {
      const lc = localById.get(sc.id);
      if (!lc) return sc;
      const result = { ...sc };
      for (const field of PROFILE_FIELDS) {
        const sv = sc[field] as string | undefined;
        const lv = lc[field] as string | undefined;
        // Promote local value only when server still has a blank placeholder.
        if ((!sv || sv === "—") && lv && lv !== "—") {
          (result as Record<string, unknown>)[field] = lv;
        }
      }
      return result;
    });

    // Merge: server (with profile protection) wins for records it knows about;
    // preserve local-only records not yet confirmed by the server.
    const serverIds = new Set(serverWithProfileProtection.map((c) => c.id));
    const localOnly = current.filter((c) => !serverIds.has(c.id));
    const merged = [...serverWithProfileProtection, ...localOnly];

    localStorage.setItem(USER_CONTACTS_KEY, JSON.stringify(merged));
    return merged;
  } catch {
    return getUserContacts(); // fall back to stale cache
  }
}

/**
 * Add a contact: persist to the server store, update localStorage cache.
 * Returns the saved contact (server may normalise it).
 *
 * Optimistic: the local cache is updated synchronously before the server
 * round-trip so callers can read `getUserContacts()` immediately after.
 */
export async function addUserContact(c: Contact): Promise<Contact> {
  const normalised = normalize(c);
  // Optimistic local update.
  const existing = getUserContacts();
  if (!existing.some((x) => x.id === normalised.id)) {
    localStorage.setItem(
      USER_CONTACTS_KEY,
      JSON.stringify([...existing, normalised])
    );
  }
  try {
    const res = await fetch("/api/contacts/user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(normalised),
    });
    if (res.ok) {
      emitChange("contacts"); // notify all surfaces of the new contact
      const data = await res.json();
      return data.contact as Contact;
    }
  } catch { /* server sync failed; cache already has the record */ }
  return normalised;
}

/**
 * Patch an existing user contact: persist to the server store, update cache.
 * Returns true if the contact was found and updated.
 *
 * Optimistic: local cache is updated before the server call.
 */
export async function updateUserContact(
  id: string,
  patch: Partial<Contact>
): Promise<boolean> {
  // Optimistic local update.
  const existing = getUserContacts();
  const idx = existing.findIndex((c) => c.id === id);
  if (idx === -1) return false;
  existing[idx] = normalize({ ...existing[idx], ...patch });
  localStorage.setItem(USER_CONTACTS_KEY, JSON.stringify(existing));

  try {
    await fetch(`/api/contacts/user/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    emitChange("contacts");
  } catch { /* cache already updated */ }
  return true;
}

/**
 * Bulk-add an array of contacts in a single server round-trip.
 *
 * Replaces the previous pattern of calling addUserContact() N times in a loop,
 * which fired N domain-change events and made N API requests.  This function
 * makes ONE POST (using the bulk-import path on /api/contacts/user) and emits
 * ONE "contacts" domain change so subscribers refresh exactly once.
 *
 * Returns the number of contacts actually added (server dedupes by id).
 * The optimistic localStorage update is applied before the server call so
 * callers can read getUserContacts() immediately after without waiting.
 */
export async function bulkAddUserContacts(contacts: Contact[]): Promise<number> {
  if (typeof window === "undefined" || contacts.length === 0) return 0;

  // Optimistic local update — add all contacts not already in cache.
  const existing    = getUserContacts();
  const existingIds = new Set(existing.map((c) => c.id));
  const toAdd       = contacts.filter((c) => !existingIds.has(c.id)).map(normalize);
  if (toAdd.length > 0) {
    localStorage.setItem(
      USER_CONTACTS_KEY,
      JSON.stringify([...existing, ...toAdd])
    );
  }

  try {
    const res = await fetch("/api/contacts/user", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ import: contacts }),
    });
    if (res.ok) {
      emitChange("contacts"); // single event for the entire batch
      const data = await res.json();
      return (data.imported as number) ?? toAdd.length;
    }
  } catch {
    /* server sync failed; optimistic cache already updated */
  }
  return toAdd.length;
}

/**
 * Delete a user contact: remove from server store, update cache.
 */
export async function deleteUserContact(id: string): Promise<void> {
  // Optimistic local update.
  const existing = getUserContacts();
  localStorage.setItem(
    USER_CONTACTS_KEY,
    JSON.stringify(existing.filter((c) => c.id !== id))
  );
  try {
    await fetch(`/api/contacts/user/${id}`, { method: "DELETE" });
    emitChange("contacts");
  } catch { /* cache already updated */ }
}

// ── Dismissed suggestions — local-only UX state ──────────────────────────────
// Per-device ephemeral state. No benefit to server-persisting these.

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

// ── Pure helpers ─────────────────────────────────────────────────────────────

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
