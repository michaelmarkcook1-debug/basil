/**
 * POST /api/admin/force-flush?secret=<secret>
 *
 * Explicitly persists the current /tmp state to BASIL_DATA.
 * Use this after reconnecting integrations to make sure tokens survive
 * the next cold start.
 */
import { NextResponse } from "next/server";
import { readStore, forceFlushSnapshot, getSnapshotDiagnostics } from "@/lib/storage/persistent";
import { readUserStore } from "@/lib/storage/user-store";
import { getSessionUser } from "@/lib/auth";

export async function POST(req: Request) {
  const expected = process.env.ADMIN_EXPORT_SECRET;
  if (!expected) {
    // Refuse to operate without an explicitly configured secret — never fall
    // back to a default so this endpoint stays closed in production.
    return NextResponse.json(
      { error: "ADMIN_EXPORT_SECRET is not configured" },
      { status: 503 }
    );
  }

  const { searchParams } = new URL(req.url);
  const secret = searchParams.get("secret") ?? "";

  if (secret !== expected) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Determine which user to warm up. Use session user if available, fall back
  // to the env-configured admin username so force-flush works without a session.
  const sessionUser = await getSessionUser().catch(() => null);
  const username = sessionUser ?? process.env.ADMIN_USERNAME ?? "michael";

  // Trigger maybeRestore AND explicitly read every known auth/data file so
  // this instance's /tmp is fully populated before we flush.
  // NOTE: memory is user-scoped (users/<username>/sage-memory.json) — read
  // via readUserStore, not readStore at root level.
  await Promise.all([
    readStore("google-tokens.json", null),
    readStore("google-watch-state.json", null),
    readStore("sage-user-contacts.json", []),
    readStore("sage-decisions.json", []),
    readUserStore(username, "sage-memory.json", []),
  ]);

  const before = Date.now();
  await forceFlushSnapshot();
  const ms = Date.now() - before;

  const diag = getSnapshotDiagnostics();
  return NextResponse.json({ ok: true, flushMs: ms, snapshot: diag });
}
