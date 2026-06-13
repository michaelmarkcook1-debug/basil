/**
 * POST /api/admin/cleanup-slack-nonmember
 *
 * One-time cleanup of already-stored Slack items (actions, decisions, memory,
 * signal events/threads) that came from channels the user is NOT a member of —
 * the backlog left behind before the ingestion membership-filter fix.
 *
 * Protected by ADMIN_API_TOKEN — no session required.
 *
 * Body:
 * {
 *   username: string;     // whose data to clean (required)
 *   dryRun?: boolean;     // DEFAULT true — reports what WOULD be removed without
 *                         // deleting. Pass dryRun:false to actually delete.
 * }
 *
 * Safety: the underlying purge is fail-closed — if Slack channel membership
 * can't be resolved it aborts and deletes nothing, and it only removes items it
 * can PROVE came from a non-member channel. Run dryRun first and review `removed`.
 */

import { NextResponse } from "next/server";
import { purgeNonMemberSlackItems } from "@/lib/slack/cleanup-nonmember";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "ADMIN_API_TOKEN is not configured." }, { status: 503 });
  }
  if ((req.headers.get("x-admin-token") ?? "") !== token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── Parse body — dryRun DEFAULTS TO TRUE (destructive op, review first) ──────
  let username = "";
  let dryRun = true;
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof body.username === "string") username = body.username.trim();
    if (typeof body.dryRun === "boolean") dryRun = body.dryRun;
  } catch {
    /* defaults */
  }

  if (!username) {
    return NextResponse.json({ error: "username is required in the request body." }, { status: 400 });
  }

  const report = await purgeNonMemberSlackItems(username, { dryRun });

  if (report.aborted) {
    return NextResponse.json(
      {
        ok: false,
        reason:
          "Could not resolve Slack channel membership (Slack not connected, an API error, rate-limit, or zero channels). Nothing was deleted.",
        ...report,
      },
      { status: 409 }
    );
  }

  return NextResponse.json({ ok: true, username, ...report });
}
