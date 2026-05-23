import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { readThreads } from "@/core/storage/signal-thread-store";
import { getFlags } from "@/core/feature-flags";
import type { SignalThreadStatus } from "@/core/primitives/signal-thread";

/**
 * GET /api/signals/threads
 *
 * Returns signal threads sorted by most-recently-active first.
 * Requires signalThread_active flag — returns empty list with hint otherwise.
 *
 * Query params:
 *   status  — "open" | "stale" | "closed" (default: all)
 *   source  — filter by primary source (gmail, slack, etc.)
 *   limit   — max results (default 50, max 200)
 *   offset  — pagination offset (default 0)
 *
 * Response:
 * {
 *   threads: SignalThread[],
 *   total: number,
 *   page: { offset, limit, returned },
 *   flagsActive: { signalThread_active },
 * }
 */

export async function GET(req: NextRequest) {
  const t0 = Date.now();
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const flags = await getFlags(username);

  if (!flags.signalThread_active) {
    return NextResponse.json({
      threads: [],
      total: 0,
      flagsActive: { signalThread_active: false },
      hint: "Enable signalThread_active flag to populate signal threads.",
    });
  }

  const { searchParams } = req.nextUrl;
  const status     = searchParams.get("status") ?? undefined;
  const source     = searchParams.get("source") ?? undefined;
  const limitParam  = parseInt(searchParams.get("limit") ?? "50", 10);
  const offsetParam = parseInt(searchParams.get("offset") ?? "0", 10);
  const limit  = Math.min(Math.max(1, Number.isNaN(limitParam) ? 50 : limitParam), 200);
  const offset = Math.max(0, Number.isNaN(offsetParam) ? 0 : offsetParam);

  // Fetch with a generous ceiling so pagination is accurate
  const all = await readThreads(username, {
    status: status as SignalThreadStatus | undefined,
    source,
    limit: 500,
  });

  const total = all.length;
  const page  = all.slice(offset, offset + limit);

  console.info(
    `[signals/threads] ${username} status=${status ?? "all"} source=${source ?? "all"} ` +
    `total=${total} returned=${page.length} ${Date.now() - t0}ms`
  );

  return NextResponse.json({
    threads: page,
    total,
    page: { offset, limit, returned: page.length },
    flagsActive: { signalThread_active: true },
  });
}
