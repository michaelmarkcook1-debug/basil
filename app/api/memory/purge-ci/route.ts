/**
 * POST /api/memory/purge-ci
 *
 * Scans the user's fact memories and removes any that look like competitive
 * intelligence, market rankings, or third-party company metrics.
 *
 * Safe to call multiple times — idempotent.
 * Returns: { removed: number; kept: number }
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { listMemories, deleteMemory } from "@/lib/memory/store";
import { forceFlushSnapshot } from "@/lib/storage/persistent";

// Same patterns as the import route guard — keep in sync.
const CI_PATTERNS: RegExp[] = [
  // ── Company as grammatical subject ────────────────────────────────────────
  // Any sentence where a company ticker/name opens the sentence is about that
  // company, not the user. Catches: "FDS headwind profile...", "Bloomberg has...",
  // "SPGI ranks...", "AlphaSense scores..." etc.
  /^(FDS|SPGI|MORN|MSCI|LSEGY|Bloomberg|AlphaSense|Morningstar|AnalystGenius)\b/i,

  // ── Explicit rankings ─────────────────────────────────────────────────────
  /\branks?\s+(1st|2nd|3rd|\d+th|first|second|third|fourth|fifth|last|#\d+)\b/i,
  /\branks?\s+\d+\/\d+\b/i,   // ratio format: "ranks 1/4", "ranks 2/6"

  // ── Score / metric language ───────────────────────────────────────────────
  /\b(pipeline|win rate|velocity|brand|deal momentum|reputation|risk|headwind)\s+(score|index|rate|profile)\b/i,
  /\brisk score\b/i,
  /\bheadwind\b/i,
  /\bwin rate\s+\d/i,
  /\bpipeline score\b/i,
  /\bvelocity score\b/i,
  /\bbrand score\b/i,
  /\bdeal momentum\b/i,
  /\breputation index\b/i,

  // ── Competitor / comparative language ────────────────────────────────────
  /\b(competitors tracked|tracked competitors|tracked as competitors)\b/i,
  /\bcompetitors (include|are|tracked)\b/i,
  /\bamong\b.{0,40}\bcompetitors?\b/i,
  /\bagainst competitors\b/i,
  /\bprimary company against\b/i,
  /\bFDS competitors\b/i,
  /\bdirect competitors\b/i,
  /\bincluding disruptors\b/i,

  // ── Ticker / company identifier facts ────────────────────────────────────
  /\bticker symbol\b/i,
  /\bstock ticker\b/i,

  // ── Dashboard / tool feature descriptions ────────────────────────────────
  /\bdashboard tracks\b/i,
  /\bthe .{2,30} dashboard (tracks|monitors|shows|displays)\b/i,

  // ── AI / risk competitive analysis ───────────────────────────────────────
  /\bAI (disruption|investment)\b.*(high|low|medium|risk|preparedness)/i,
  /\bdisruption risk\b/i,
  /\bAI disruption preparedness\b/i,

  // ── Market / industry section labels ─────────────────────────────────────
  /\bcompetitive intelligence\b/i,
  /\bfinancial snapshot\b.*(dashboard|track|monitor)/i,
  /\b(economic pressure|regulatory exposure)\b/i,
];

function isCI(content: string): boolean {
  return CI_PATTERNS.some((re) => re.test(content));
}

export async function POST() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const memories = await listMemories(username);

  const toDelete = memories.filter(
    (m) => m.kind === "fact" && isCI(m.content)
  );

  for (const m of toDelete) {
    await deleteMemory(username, m.id);
    console.log(`[memory/purge-ci] Deleted: "${m.content.slice(0, 80)}"`);
  }

  if (toDelete.length > 0) {
    await forceFlushSnapshot();
  }

  return NextResponse.json({
    removed: toDelete.length,
    kept:    memories.length - toDelete.length,
  });
}
