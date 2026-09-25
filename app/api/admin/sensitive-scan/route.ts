/**
 * GET /api/admin/sensitive-scan
 *
 * Existing-cache remediation, step one: FIND OUT. Reports, for the signed-in
 * user, how many credential-shaped values sit in records that were generated
 * or saved before redaction existed. Counts only — never the values, never a
 * deletion. Deciding what to purge is a human decision made from this report.
 *
 * Reads the RAW records (readStore, not readGenerateCache) because the cache
 * layer now scrubs on read and would report zero for everything.
 */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { readStore } from "@/lib/storage/persistent";
import { readUserStore } from "@/lib/storage/user-store";
import { redactDeep } from "@/lib/security/sensitive";

export const dynamic = "force-dynamic";

const CACHE_TYPES = ["briefing", "digest", "meeting-prep"] as const;

function cacheSubdir(username: string): string {
  // Mirrors lib/generate-cache/store.ts — kept private there on purpose.
  const safe = username.toLowerCase().replace(/[^a-zA-Z0-9._-]/g, "_");
  return `users/${safe}/cache`;
}

export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const report: Array<{ store: string; records: number; redactionsNeeded: number; generatedAt?: string }> = [];

  for (const type of CACHE_TYPES) {
    const rec = await readStore<{ generatedAt?: string; content?: unknown } | null>(`${type}.json`, null, cacheSubdir(username), { fresh: true });
    if (!rec) { report.push({ store: `cache:${type}`, records: 0, redactionsNeeded: 0 }); continue; }
    report.push({ store: `cache:${type}`, records: 1, redactionsNeeded: redactDeep(rec.content).count, generatedAt: rec.generatedAt });
  }

  const history = await readUserStore<Array<{ content?: string }>>(username, "chat-history.json", [], { fresh: true });
  report.push({ store: "chat-history", records: history.length, redactionsNeeded: redactDeep(history.map((m) => m.content ?? "")).count });

  const actions = await readUserStore<Array<{ text?: string }>>(username, "sage-actions.json", [], { fresh: true });
  report.push({ store: "actions", records: actions.length, redactionsNeeded: redactDeep(actions.map((a) => a.text ?? "")).count });

  const total = report.reduce((n, r) => n + r.redactionsNeeded, 0);
  return NextResponse.json({
    username,
    scannedAt: new Date().toISOString(),
    total,
    report,
    note: "Counts only. Nothing was modified. Cached artifacts are redacted on read; delete via Regenerate on the page, or deleteGenerateCache, if a clean durable copy is wanted.",
  });
}
