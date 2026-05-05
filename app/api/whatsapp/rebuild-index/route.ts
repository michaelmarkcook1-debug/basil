/**
 * POST /api/whatsapp/rebuild-index
 *
 * Builds (or rebuilds) the compact WhatsApp signal index from the snapshot
 * and persists it. Called silently from the WhatsApp page on mount to bootstrap
 * the signal index on warm instances that still have the snapshot file on disk.
 *
 * Returns { ok: true, chats: N } on success, { ok: false, reason: "..." } if
 * the snapshot is not available on this instance.
 */

import { NextResponse } from "next/server";
import { getSnapshot, persistSignalIndex } from "@/lib/whatsapp/dump-job";
import { forceFlushSnapshot } from "@/lib/storage/persistent";
import { getSessionUser } from "@/lib/auth";

export async function POST() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const snapshot = await getSnapshot(username);
  if (!snapshot) {
    return NextResponse.json({ ok: false, reason: "no_snapshot" }, { status: 200 });
  }

  await persistSignalIndex(username, snapshot);
  await forceFlushSnapshot();

  return NextResponse.json({ ok: true, chats: snapshot.chats.filter((c) => !c.isGroup).length });
}
