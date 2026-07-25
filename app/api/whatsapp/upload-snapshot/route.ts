/**
 * POST /api/whatsapp/upload-snapshot
 *
 * Receives a WhatsApp snapshot captured by the local `npm run whatsapp:import`
 * CLI worker and stores it durably.  This is the preferred import path because
 * the CLI runs Baileys on the developer's own machine — no Vercel function
 * timeout, no multi-instance state problem, no QR reliability issues.
 *
 * Authentication: Bearer token from WHATSAPP_UPLOAD_TOKEN env var.
 * The CLI worker must send:
 *   Authorization: Bearer <WHATSAPP_UPLOAD_TOKEN>
 *   X-Basil-Username: <username>
 *
 * Body: { snapshot: Snapshot } — or the raw Snapshot object — as JSON.
 *
 * Storage pattern (same as dump-job.ts):
 *   1. writeStore("whatsapp-snapshot.json", …, { durability: "strong" }) → L1 + Blob (awaited).
 *   2. persistSignalIndex → writeStore → Blob (strong, awaited internally).
 *   3. bulkImportUserContacts → writeUserStore → Blob (strong, awaited internally).
 * No manual forceFlushSnapshot() needed — strong writes await Blob inline.
 * After a cold start the /tmp file may be absent; getSnapshot() falls back to
 * readStore (Blob) and getWhatsAppSignalForContact falls back to the signal index.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  persistSignalIndex,
  type Snapshot,
} from "@/lib/whatsapp/dump-job";
import { bulkImportUserContacts } from "@/lib/contacts/user-store";
import { writeStore } from "@/lib/storage/persistent";
import { timingSafeEqualStr } from "@/lib/auth/safe-compare";
import { initialsFor, pickAvatarColor } from "@/lib/user-contacts";
import type { Contact } from "@/lib/contacts-data";

function safeUser(u: string): string {
  // Lowercase first: usernames are case-insensitive, so the upload path matches
  // the (lowercased) read path — otherwise a differently-cased X-Basil-Username
  // header would write a snapshot the reader never finds.
  return u.toLowerCase().replace(/[^a-zA-Z0-9._-]/g, "_");
}

function userSubdir(username: string): string {
  return `users/${safeUser(username)}`;
}

export async function POST(req: NextRequest) {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const uploadToken = process.env.WHATSAPP_UPLOAD_TOKEN;
  if (!uploadToken) {
    console.error("[whatsapp/upload] WHATSAPP_UPLOAD_TOKEN env var is not set");
    return NextResponse.json(
      { error: "WHATSAPP_UPLOAD_TOKEN is not configured on this server." },
      { status: 503 }
    );
  }
  const authHeader = req.headers.get("authorization") ?? "";
  if (!timingSafeEqualStr(authHeader, `Bearer ${uploadToken}`)) {
    console.warn("[whatsapp/upload] Rejected request with invalid token");
    return NextResponse.json({ error: "Invalid upload token." }, { status: 401 });
  }

  // ── Username ─────────────────────────────────────────────────────────────────
  const username = req.headers.get("x-basil-username")?.trim();
  if (!username) {
    return NextResponse.json(
      { error: "X-Basil-Username header is required." },
      { status: 400 }
    );
  }
  // The upload token is a single SHARED secret. Without a scope, any holder could
  // set X-Basil-Username to an arbitrary account and write into someone else's
  // contacts (IDOR). When WHATSAPP_UPLOAD_USERNAME is set, the token may only
  // write to that one account. Leave it unset only for single-user deployments.
  const pinnedUser = process.env.WHATSAPP_UPLOAD_USERNAME?.trim();
  if (pinnedUser && username.toLowerCase() !== pinnedUser.toLowerCase()) {
    console.warn(`[whatsapp/upload] Rejected write to ${username} — token is pinned to ${pinnedUser}`);
    return NextResponse.json({ error: "This upload token is not authorised for that account." }, { status: 403 });
  }

  // ── Snapshot body ────────────────────────────────────────────────────────────
  let snapshot: Snapshot;
  try {
    const body = (await req.json()) as { snapshot?: Snapshot } | Snapshot;
    // Accept either { snapshot: ... } wrapper or the raw snapshot object.
    snapshot = (body as { snapshot?: Snapshot }).snapshot ?? (body as Snapshot);
    if (!Array.isArray(snapshot?.chats) || !Array.isArray(snapshot?.contacts)) {
      throw new Error("Missing chats or contacts array in snapshot.");
    }
  } catch (e) {
    return NextResponse.json(
      { error: `Invalid snapshot body: ${e instanceof Error ? e.message : String(e)}` },
      { status: 400 }
    );
  }

  console.log(
    `[whatsapp/upload] ${username}: received snapshot — ` +
    `${snapshot.chatCount} chats, ${snapshot.messageCount} msgs, ` +
    `${snapshot.contactCount} contacts (captured ${snapshot.capturedAt})`
  );

  try {
    // ── Persist snapshot → writeStore → L1 (/tmp) + L2 (Blob) ───────────────────
    // Strong durability: awaits Blob write before continuing so the snapshot
    // survives cold starts without a manual forceFlushSnapshot() call.
    await writeStore("whatsapp-snapshot.json", snapshot, userSubdir(username), { durability: "strong" });

    // ── Compact signal index → writeStore → Blob (strong internally) ─────────
    await persistSignalIndex(username, snapshot);

    // ── Build and import Contact stubs ─────────────────────────────────────────
    const stubs: Contact[] = snapshot.contacts
      .filter(
        (c) =>
          c.id.endsWith("@s.whatsapp.net") &&
          c.id !== snapshot.meJid &&
          snapshot.chats.some((ch) => ch.id === c.id)
      )
      .map((c) => {
        const jidUser = c.id.split("@")[0];
        const stableId = `wa-${jidUser}`;
        const chatName = snapshot.chats.find((ch) => ch.id === c.id)?.name?.trim();
        const displayName =
          chatName ||
          c.name?.trim() ||
          c.pushName?.trim() ||
          c.notify?.trim() ||
          c.phoneNumber?.trim() ||
          jidUser;
        const lastMessageAt = snapshot.chats.find((ch) => ch.id === c.id)?.lastMessageAt;

        return {
          id: stableId,
          name: displayName,
          initials: initialsFor(displayName),
          color: pickAvatarColor(stableId),
          title: "WhatsApp contact",
          company: "—",
          email: undefined,
          phone: c.phoneNumber ?? undefined,
          tags: ["whatsapp"],
          status: "pending" as const,
          type: "external" as const,
          directory: "personal" as const,
          relationship: "Imported from WhatsApp.",
          companyContext: "—",
          personality: "—",
          whatMakesThemTick: "—",
          watchOut: "—",
          recentActivity: "—",
          activitySource: "WhatsApp",
          lastInteraction: lastMessageAt?.substring(0, 10),
          source: "whatsapp-import" as const,
        } satisfies Contact;
      });

    const result = await bulkImportUserContacts(username, stubs);

    console.log(
      `[whatsapp/upload] ${username}: import done — ` +
      `added=${result.added} updated=${result.updated} unchanged=${result.unchanged} ` +
      `unresolved=${result.unresolved} total=${stubs.length}`
    );

    return NextResponse.json({
      ok: true,
      capturedAt: snapshot.capturedAt,
      chatCount: snapshot.chatCount,
      messageCount: snapshot.messageCount,
      added: result.added,
      updated: result.updated,
      unchanged: result.unchanged,
      unresolved: result.unresolved,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[whatsapp/upload] ${username}: failed — ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
