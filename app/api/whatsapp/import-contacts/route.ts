/**
 * GET  /api/whatsapp/import-contacts  — read-only preview of importable contacts
 * POST /api/whatsapp/import-contacts  — server-side import with guaranteed persistence
 *
 * The POST handler moves stub-building entirely to the server so it can:
 *  - Use stable JID-based IDs (immune to name changes / re-import drift)
 *  - Call bulkImportUserContacts with proper deduplication
 *  - Await forceFlushSnapshot() before responding, guaranteeing BASIL_DATA is
 *    current before the client gets a 201 — contacts survive Vercel cold starts.
 *
 * State model:
 *  - WhatsApp contacts are CANONICAL TRUTH in sage-user-contacts.json
 *  - They are NOT derived cache — they must not be overwritten by re-import
 *  - The client's localStorage is a write-through cache, refreshed via
 *    loadUserContactsFromServer() after every import
 */

import { NextResponse } from "next/server";
import { getSnapshot, persistSignalIndex } from "@/lib/whatsapp/dump-job";
import { bulkImportUserContacts } from "@/lib/contacts/user-store";
import { forceFlushSnapshot } from "@/lib/storage/persistent";
import type { Contact } from "@/lib/contacts-data";

// ── Pure helpers (inlined to avoid server/client boundary issues) ─────────────

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function pickAvatarColor(seed: string): string {
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
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

/**
 * Build a display name from a WhatsApp snapshot contact.
 * Precedence: saved contact name > WhatsApp push name > notify name > phone > JID user
 * Never returns an empty string.
 */
function resolveDisplayName(c: {
  name?: string;
  pushName?: string;
  notify?: string;
  phoneNumber?: string;
  jidUser: string;
}): string {
  return (
    c.name?.trim() ||
    c.pushName?.trim() ||
    c.notify?.trim() ||
    c.phoneNumber?.trim() ||
    c.jidUser
  );
}

// ── GET — read-only preview ───────────────────────────────────────────────────

export async function GET() {
  const t0 = Date.now();
  const snapshot = await getSnapshot();
  if (!snapshot) {
    return NextResponse.json(
      { error: "No snapshot yet — import WhatsApp first" },
      { status: 404 }
    );
  }

  const candidates = snapshot.contacts
    .filter((c) => c.id.endsWith("@s.whatsapp.net") && c.id !== snapshot.meJid)
    .map((c) => {
      const jidUser = c.id.split("@")[0];
      const displayName = resolveDisplayName({ ...c, jidUser });
      return {
        jid: c.id,
        name: displayName,
        phone: c.phoneNumber,
        lastMessageAt: snapshot.chats.find((ch) => ch.id === c.id)?.lastMessageAt,
        hasChat: snapshot.chats.some((ch) => ch.id === c.id),
      };
    })
    .filter((c) => c.name || c.phone);

  const withChat = candidates.filter((c) => c.hasChat);
  const noChat = candidates.filter((c) => !c.hasChat);
  return NextResponse.json({
    capturedAt: snapshot.capturedAt,
    withChat,
    noChat,
  });
}

// ── POST — server-side import with guaranteed snapshot flush ──────────────────

export async function POST() {
  const t0 = Date.now();
  const snapshot = await getSnapshot();
  if (!snapshot) {
    return NextResponse.json({ error: "No snapshot" }, { status: 404 });
  }

  // Build stubs for all 1:1 contacts that have at least one chat.
  // Stubs with an existing ID are skipped by bulkImportUserContacts (idempotent).
  const stubs: Contact[] = snapshot.contacts
    .filter((c) => c.id.endsWith("@s.whatsapp.net") && c.id !== snapshot.meJid)
    .filter((c) => snapshot.chats.some((ch) => ch.id === c.id)) // only real conversations
    .map((c) => {
      const jidUser = c.id.split("@")[0];

      // Stable ID: derived from the JID user part (phone number without +).
      // Immutable across name changes — same person always maps to the same ID.
      const stableId = `wa-${jidUser}`;

      // Prefer the chat's display name: it was resolved by chatDisplayName()
      // during snapshot building, which already applied address-book name →
      // push name → notify → phone fallback.  The snapshot.contacts entry
      // for the same JID can be sparser (especially for contacts not in the
      // address book).
      const chatDisplayName = snapshot.chats.find((ch) => ch.id === c.id)?.name?.trim();
      const displayName = chatDisplayName || resolveDisplayName({ ...c, jidUser });
      const phone = c.phoneNumber || undefined;
      const lastMessageAt = snapshot.chats.find((ch) => ch.id === c.id)?.lastMessageAt;

      return {
        id: stableId,
        name: displayName,
        initials: initialsFor(displayName),
        // Color seeded from stable ID so it never changes on rename.
        color: pickAvatarColor(stableId),
        title: "WhatsApp contact",
        company: "—",
        email: undefined,
        phone,
        tags: ["whatsapp"],
        status: "pending" as const,
        type: "external" as const,
        // WhatsApp contacts always belong in the Personal directory.
        directory: "personal" as const,
        relationship: "Imported from WhatsApp.",
        companyContext: "—",
        personality: "—",
        whatMakesThemTick: "—",
        watchOut: "—",
        recentActivity: "—",
        activitySource: "WhatsApp",
        lastInteraction: lastMessageAt?.substring(0, 10),
      } satisfies Contact;
    });

  // Count how many stubs could not be resolved to a real name — just a phone number.
  const phonePattern = /^\+?\d[\d\s\-(). ]{4,}$/;
  const unresolved = stubs.filter((s) => phonePattern.test(s.name.trim())).length;


  // Write to canonical store (server file-system + in-memory).
  const imported = await bulkImportUserContacts(stubs);

  // ── Build compact signal index ───────────────────────────────────────────
  // The full whatsapp-snapshot.json is excluded from BASIL_DATA (too large).
  // Persist a trimmed index so getWhatsAppSignalForContact works on cold-start
  // instances that haven't seen the snapshot file.
  await persistSignalIndex(snapshot);

  // ── Guaranteed persistence ────────────────────────────────────────────────
  // forceFlushSnapshot() awaits the full BASIL_DATA env-var write before this
  // function returns.  This is what the fire-and-forget in writeStore cannot
  // guarantee — on Vercel a function can be recycled before the background
  // promise resolves, leaving BASIL_DATA stale and contacts lost on cold start.
  await forceFlushSnapshot();

  // Return the full stubs list so the client can seed localStorage directly
  // without a second GET that might hit a stale Vercel instance.
  return NextResponse.json(
    { imported, total: stubs.length, unresolved, contacts: stubs },
    { status: 201 }
  );
}
