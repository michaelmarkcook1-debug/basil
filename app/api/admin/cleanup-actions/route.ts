/**
 * POST /api/admin/cleanup-actions
 *
 * Bulk-removes Slack-sourced actions that were created for the wrong person
 * (channel broadcast noise, actions assigned to named third parties, etc.).
 *
 * Protected by ADMIN_API_TOKEN — no session required.
 *
 * Body (all optional):
 * {
 *   username: string;          // whose actions to clean — defaults to the configured owner
 *   source?: string;           // filter by source, e.g. "slack" (default)
 *   dryRun?: boolean;          // if true, report what would be deleted without deleting
 *   keepOwners?: string[];     // owner values to KEEP (default: target-user-ish names + blank)
 *   beforeDate?: string;       // ISO date — only delete actions created before this date
 * }
 *
 * Returns { deleted: number; kept: number; dryRun: boolean; removed: string[] }
 */

import { NextResponse } from "next/server";
import { listActions, deleteAction } from "@/lib/actions/store";

export const dynamic = "force-dynamic";

/** Returns true if the owner value refers to the target user or is unset. */
function isOwnerOrUnset(owner: string | undefined | null, targetUser: string): boolean {
  if (!owner || !owner.trim()) return true;
  const o = owner.trim().toLowerCase();
  if (o === "me" || o === "i" || o === "unknown") return true;
  const target = targetUser.trim().toLowerCase();
  if (target && o.includes(target)) return true;
  return false;
}

export async function POST(req: Request) {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "ADMIN_API_TOKEN is not configured." }, { status: 503 });
  }
  const authHeader = req.headers.get("x-admin-token") ?? "";
  if (authHeader !== token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── Parse body ──────────────────────────────────────────────────────────────
  let username = "";
  let source = "slack";
  let dryRun = false;
  let keepOwners: string[] | null = null;
  let beforeDate: string | null = null;

  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    if (typeof body.username === "string") username = body.username.trim();
    if (typeof body.source === "string") source = body.source.trim();
    if (typeof body.dryRun === "boolean") dryRun = body.dryRun;
    if (Array.isArray(body.keepOwners)) keepOwners = body.keepOwners as string[];
    if (typeof body.beforeDate === "string") beforeDate = body.beforeDate;
  } catch {
    // defaults are fine
  }

  // ── Load actions ────────────────────────────────────────────────────────────
  if (!username) {
    return NextResponse.json(
      { error: "username is required in the request body." },
      { status: 400 }
    );
  }
  const all = await listActions(username);

  const toDelete: { id: string; text: string; owner: string | undefined }[] = [];
  const toKeep: string[] = [];

  for (const action of all) {
    // Only consider the target source
    if (source && action.source !== source) {
      toKeep.push(action.id);
      continue;
    }

    // Date filter
    if (beforeDate && action.createdAt && action.createdAt >= beforeDate) {
      toKeep.push(action.id);
      continue;
    }

    // Owner check
    const owner = action.owner ?? "";
    const shouldKeep = keepOwners
      ? keepOwners.some((k) => owner.toLowerCase().includes(k.toLowerCase()))
      : isOwnerOrUnset(owner, username);

    if (shouldKeep) {
      toKeep.push(action.id);
    } else {
      toDelete.push({ id: action.id, text: action.text, owner: action.owner });
    }
  }

  // ── Delete (unless dry run) ─────────────────────────────────────────────────
  let deleted = 0;
  const removedTexts: string[] = [];

  if (!dryRun) {
    for (const item of toDelete) {
      try {
        const ok = await deleteAction(username, item.id);
        if (ok) {
          deleted++;
          removedTexts.push(`[${item.owner ?? "blank"}] ${item.text.slice(0, 80)}`);
        }
      } catch (err) {
        console.error("[cleanup-actions] failed to delete", item.id, err instanceof Error ? err.message : err);
      }
    }
  } else {
    removedTexts.push(...toDelete.map((i) => `[${i.owner ?? "blank"}] ${i.text.slice(0, 80)}`));
    deleted = toDelete.length;
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    source,
    username,
    deleted,
    kept: toKeep.length,
    removed: removedTexts,
  });
}
