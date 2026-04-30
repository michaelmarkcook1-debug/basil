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
  /\branks?\s+(1st|2nd|3rd|\d+th|first|second|third|fourth|fifth|last|#\d+)\b/i,
  /\b(pipeline|win rate|velocity|brand|deal momentum|reputation)\s+(score|index|rate)\b/i,
  /\bwin rate\s+\d/i,
  /\bpipeline score\b/i,
  /\bvelocity score\b/i,
  /\bbrand score\b/i,
  /\bdeal momentum\b/i,
  /\breputation index\b/i,
  /\b(competitors tracked|tracked competitors|tracked as competitors)\b/i,
  /\bcompetitors (include|are|tracked)\b/i,
  /^(SPGI|MORN|MSCI|LSEGY|FDS|SPGI|GS|MS)\b.*(rank|score|rate|index)/i,
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
