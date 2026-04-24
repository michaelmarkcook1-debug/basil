/**
 * Server-side persistent store for user-added contacts.
 *
 * These are contacts Michael has added from the "Suggested" strip — they share
 * the Contact shape but live in the server store rather than localStorage so:
 *   - AI features (drafter, meeting-prep, chat tools) can look them up without
 *     requiring the client to forward them in every request body.
 *   - The authoritative list is device-independent and survives browser clears.
 *
 * Seed contacts (lib/contacts-data.ts) are compile-time constants and are never
 * stored here.  This store holds only user-created additions.
 */

import { randomUUID } from "node:crypto";
import type { Contact } from "@/lib/contacts-data";
import { readStore, writeStore } from "@/lib/storage/persistent";
import { withLock } from "@/lib/events/lock";

const CONTACTS_FILE = "sage-user-contacts.json";
const LOCK_KEY = "user-contacts";

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

async function readAll(): Promise<Contact[]> {
  const items = await readStore<Contact[]>(CONTACTS_FILE, []);
  return items.map(normalize);
}

async function writeAll(items: Contact[]): Promise<void> {
  await writeStore(CONTACTS_FILE, items);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function listUserContacts(): Promise<Contact[]> {
  return readAll();
}

export async function addUserContactToStore(contact: Contact): Promise<Contact> {
  return withLock(LOCK_KEY, async () => {
    const items = await readAll();
    if (items.some((x) => x.id === contact.id)) return contact; // idempotent
    const normalised = normalize(contact);
    await writeAll([...items, normalised]);
    return normalised;
  });
}

export async function updateUserContactInStore(
  id: string,
  patch: Partial<Contact>
): Promise<Contact | null> {
  return withLock(LOCK_KEY, async () => {
    const items = await readAll();
    const idx = items.findIndex((c) => c.id === id);
    if (idx === -1) return null;
    items[idx] = normalize({ ...items[idx], ...patch });
    await writeAll(items);
    return items[idx];
  });
}

export async function deleteUserContactFromStore(id: string): Promise<boolean> {
  return withLock(LOCK_KEY, async () => {
    const items = await readAll();
    const next = items.filter((c) => c.id !== id);
    if (next.length === items.length) return false;
    await writeAll(next);
    return true;
  });
}

/**
 * Bulk import — used once on first load to migrate any contacts that were
 * already stored in the client-side localStorage before this store existed.
 * Skips contacts whose id already exists.
 */
export async function bulkImportUserContacts(
  incoming: Contact[]
): Promise<number> {
  return withLock(LOCK_KEY, async () => {
    const items = await readAll();
    const existingIds = new Set(items.map((c) => c.id));
    let added = 0;
    for (const c of incoming) {
      if (!existingIds.has(c.id)) {
        items.push(normalize(c));
        added++;
      }
    }
    if (added > 0) await writeAll(items);
    return added;
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
