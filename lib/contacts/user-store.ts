/**
 * Server-side persistent store for user-added contacts (per-user).
 *
 * All public functions require a `username` argument.  Data is stored under
 * DATA_DIR/users/<username>/sage-user-contacts.json so each user's contacts
 * are completely isolated.
 *
 * Seed contacts (lib/contacts-data.ts) are compile-time constants and are never
 * stored here.  This store holds only user-created additions.
 */

import { randomUUID } from "node:crypto";
import type { Contact } from "@/lib/contacts-data";
import { readUserStore, writeUserStore } from "@/lib/storage/user-store";
import { withLock } from "@/lib/events/lock";

const CONTACTS_FILE = "sage-user-contacts.json";

function lockKey(username: string): string {
  return `user-contacts:${username}`;
}

// ── Normaliser ───────────────────────────────────────────────────────────────
// 1. Back-compat: older records may be missing `directory` → default "work".
// 2. Domain tagging: @talentgenius.io email → force internal/work.
// 3. Name guard: never persist a blank name — fall back to phone or id.
function normalize(c: Contact): Contact {
  // 1. Directory back-compat
  let out: Contact = c.directory ? c : { ...c, directory: "work" as const };

  // 2. Name guard — blank names must never reach the store.
  //    Precedence: existing name → phone (clean fallback for WhatsApp contacts) → id.
  const name = out.name?.trim();
  if (!name) {
    out = { ...out, name: out.phone?.trim() || out.id };
  }

  // 3. TalentGenius domain tagging
  if (out.email && out.email.toLowerCase().endsWith("@talentgenius.io")) {
    out = {
      ...out,
      type: "internal",
      company: out.company && out.company !== "—" ? out.company : "TalentGenius",
      directory: "work",
    };
  }

  return out;
}

async function readAll(username: string): Promise<Contact[]> {
  const items = await readUserStore<Contact[]>(username, CONTACTS_FILE, []);
  return items.map(normalize);
}

async function writeAll(username: string, items: Contact[]): Promise<void> {
  await writeUserStore(username, CONTACTS_FILE, items);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function listUserContacts(username: string): Promise<Contact[]> {
  return readAll(username);
}

export async function addUserContactToStore(username: string, contact: Contact): Promise<Contact> {
  return withLock(lockKey(username), async () => {
    const items = await readAll(username);
    if (items.some((x) => x.id === contact.id)) return contact; // idempotent
    const normalised = normalize(contact);
    await writeAll(username, [...items, normalised]);
    return normalised;
  });
}

export async function updateUserContactInStore(
  username: string,
  id: string,
  patch: Partial<Contact>
): Promise<Contact | null> {
  return withLock(lockKey(username), async () => {
    const items = await readAll(username);
    const idx = items.findIndex((c) => c.id === id);
    if (idx === -1) return null;
    items[idx] = normalize({ ...items[idx], ...patch });
    await writeAll(username, items);
    return items[idx];
  });
}

export async function deleteUserContactFromStore(username: string, id: string): Promise<boolean> {
  return withLock(lockKey(username), async () => {
    const items = await readAll(username);
    const next = items.filter((c) => c.id !== id);
    if (next.length === items.length) return false;
    await writeAll(username, next);
    return true;
  });
}

/**
 * Returns true when a name is just a raw phone number (no real name attached).
 * Used to decide whether a fresh import's resolved name is an upgrade.
 */
function looksLikePhoneNumber(name: string): boolean {
  return /^\+?\d[\d\s\-(). ]{4,}$/.test(name.trim());
}

/** Non-empty string that isn't a dash/placeholder sentinel. */
function hasRealValue(v: string | undefined): v is string {
  return !!v && v.trim().length > 0 && v.trim() !== "—";
}

export interface BulkImportResult {
  /** Contacts that did not exist before and were added. */
  added: number;
  /** Contacts that existed but received richer field values. */
  updated: number;
  /** Contacts that existed and had no upgrades to apply. */
  unchanged: number;
  /** Incoming stubs with no resolvable name (still a phone number). */
  unresolved: number;
}

/**
 * Bulk import — idempotent by ID.
 *
 * New contacts are appended.  Existing contacts receive richer field values
 * when the incoming stub has better data:
 *   - name upgrade: stored name is a raw phone number → incoming has a real name
 *   - title upgrade: stored title is the placeholder "WhatsApp contact" → incoming differs
 *   - phone, lastInteraction, activitySource: incoming has a value, stored is missing
 *   - tags: incoming tags are merged (union) into the stored set
 *
 * Returns { added, updated, unchanged, unresolved } so callers can show exact counts.
 */
export async function bulkImportUserContacts(
  username: string,
  incoming: Contact[]
): Promise<BulkImportResult> {
  return withLock(lockKey(username), async () => {
    const items = await readAll(username);
    const existingById = new Map(items.map((c) => [c.id, c]));
    let added = 0;
    let updated = 0;
    let unchanged = 0;
    let unresolved = 0;

    for (const c of incoming) {
      const existing = existingById.get(c.id);
      if (!existing) {
        items.push(normalize(c));
        added++;
        continue;
      }

      // --- Upgrade existing record with richer values from the incoming stub ---
      let patch: Partial<Contact> = {};

      // Name: upgrade from phone-number placeholder to a real resolved name.
      if (looksLikePhoneNumber(existing.name) && hasRealValue(c.name) && !looksLikePhoneNumber(c.name)) {
        patch = {
          ...patch,
          name: c.name,
          initials: c.initials,
          color: c.color,
        };
      }

      // Track unresolved even if no upgrade applies.
      if (looksLikePhoneNumber(c.name)) unresolved++;

      // Title: replace stale "WhatsApp contact" placeholder with a real value.
      if (existing.title === "WhatsApp contact" && hasRealValue(c.title) && c.title !== "WhatsApp contact") {
        patch.title = c.title;
      }

      // Phone: fill in if stored is missing.
      if (!hasRealValue(existing.phone) && hasRealValue(c.phone)) {
        patch.phone = c.phone;
      }

      // lastInteraction: take whichever is newer.
      if (hasRealValue(c.lastInteraction)) {
        if (!hasRealValue(existing.lastInteraction) ||
            c.lastInteraction! > existing.lastInteraction!) {
          patch.lastInteraction = c.lastInteraction;
        }
      }

      // activitySource: fill in if stored is missing.
      if (!hasRealValue(existing.activitySource) && hasRealValue(c.activitySource)) {
        patch.activitySource = c.activitySource;
      }

      // tags: union merge (dedupe).
      if (c.tags.length > 0) {
        const merged = Array.from(new Set([...existing.tags, ...c.tags]));
        if (merged.length > existing.tags.length) {
          patch.tags = merged;
        }
      }

      if (Object.keys(patch).length > 0) {
        const idx = items.findIndex((x) => x.id === c.id);
        if (idx !== -1) {
          items[idx] = normalize({ ...items[idx], ...patch });
          updated++;
        }
      } else {
        unchanged++;
      }
    }

    if (added > 0 || updated > 0) await writeAll(username, items);
    return { added, updated, unchanged, unresolved };
  });
}

/**
 * Generate a stable id from a name/email string — the same algorithm used by
 * the old client-side `slugifyId` helper so migrated records keep their ids.
 */
export function slugifyContactId(source: string): string {
  return source
    .toLowerCase()
    .replace(/@.*$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || randomUUID().slice(0, 8);
}
