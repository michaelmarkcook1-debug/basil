import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { readSignalEvents } from "@/core/storage/signal-event-store";
import { SURFACE_THRESHOLD, DIGEST_THRESHOLD } from "@/core/primitives/ranked-signal";
import { getFlags } from "@/core/feature-flags";
import type { SignalSource } from "@/core/primitives/signal-event";

/**
 * GET /api/signals/ranked
 *
 * Returns signals sorted by ranking.score descending.
 * Requires signalEvent_active + ranking_active flags to be true,
 * otherwise returns an empty list with a hint.
 *
 * Query params:
 *   source     — filter by source (gmail, slack, etc.)
 *   category   — filter by signal category
 *   tier        — "surface" (score ≥ 0.70) | "digest" (score ≥ 0.35) | "all"
 *   limit       — max results (default 25, max 100)
 *   offset      — pagination offset (default 0)
 *
 * Response:
 * {
 *   signals: RankedSignalView[],  // scored, enriched for display
 *   total: number,                // total matching before offset/limit
 *   thresholds: { surface, digest },
 *   flagsActive: { signalEvent_active, ranking_active },
 * }
 */

export async function GET(req: NextRequest) {
  const t0 = Date.now();
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const flags = await getFlags(username);

  // Early return if primitives aren't active yet — don't 404, just explain
  if (!flags.signalEvent_active || !flags.ranking_active) {
    return NextResponse.json({
      signals: [],
      total: 0,
      thresholds: { surface: SURFACE_THRESHOLD, digest: DIGEST_THRESHOLD },
      flagsActive: {
        signalEvent_active: flags.signalEvent_active,
        ranking_active: flags.ranking_active,
      },
      hint: "Enable signalEvent_active and ranking_active flags to populate ranked signals.",
    });
  }

  const { searchParams } = req.nextUrl;
  const source    = searchParams.get("source") ?? undefined;
  const category  = searchParams.get("category") ?? undefined;
  const tier      = searchParams.get("tier") ?? "digest";
  const limitParam  = parseInt(searchParams.get("limit") ?? "25", 10);
  const offsetParam = parseInt(searchParams.get("offset") ?? "0", 10);
  const limit  = Math.min(Math.max(1, Number.isNaN(limitParam) ? 25 : limitParam), 100);
  const offset = Math.max(0, Number.isNaN(offsetParam) ? 0 : offsetParam);

  // Score floor based on tier
  const minScore =
    tier === "surface" ? SURFACE_THRESHOLD :
    tier === "all"     ? 0 :
    DIGEST_THRESHOLD;

  let signals = await readSignalEvents(username, {
    source: source as SignalSource | undefined,
    limit: 500,   // fetch wide, filter + sort in memory
  });

  // Filter to ranked signals only, above the tier floor
  signals = signals.filter(
    (s) => s.ranking && s.ranking.score >= minScore
  );

  // Category filter
  if (category) {
    signals = signals.filter((s) => s.category === category);
  }

  // Sort by score descending
  signals.sort((a, b) => (b.ranking!.score - a.ranking!.score));

  const total = signals.length;
  const page  = signals.slice(offset, offset + limit);

  // Project a display-safe view — no raw body, just what the UI needs
  const views = page.map((s) => ({
    id: s.id,
    sourceRef: s.sourceRef,
    source: s.source,
    title: s.title,
    snippet: s.snippet,
    category: s.category,
    occurredAt: s.occurredAt,
    ingestedAt: s.ingestedAt,
    participants: s.participants.map((p) => ({
      name: p.rawName,
      email: p.rawEmail,
      role: p.role,
      canonicalId: p.canonicalId,
    })),
    actionCount: s.actions.length,
    decisionCount: s.decisions.length,
    actionIds: s.actionIds,
    decisionIds: s.decisionIds,
    threadId: s.threadId,
    ranking: s.ranking,
  }));

  console.info(
    `[signals/ranked] ${username} tier=${tier} total=${total} returned=${views.length} ${Date.now() - t0}ms`
  );

  return NextResponse.json({
    signals: views,
    total,
    page: { offset, limit, returned: views.length },
    thresholds: { surface: SURFACE_THRESHOLD, digest: DIGEST_THRESHOLD },
    flagsActive: { signalEvent_active: true, ranking_active: true },
  });
}
