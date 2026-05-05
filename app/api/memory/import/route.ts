/**
 * POST /api/memory/import
 *
 * Accepts a block of text — AI conversation, document, notes, file contents —
 * and uses Claude to extract structured memories from it, then saves them.
 *
 * Handles large inputs by chunking into ~40K-char passes and merging results.
 *
 * Body: { text: string }
 * Returns: { imported: number; memories: Memory[] }
 */

export const maxDuration = 300;

import { NextResponse } from "next/server";
import { generateText } from "ai";
import { getTextModel, MAX_TOKENS } from "@/lib/ai/model-config";
import { parseAndValidate } from "@/lib/ai/parse-json";
import { MemoryImportArraySchema } from "@/lib/ai/schemas";
import { getSessionUser } from "@/lib/auth";
import { createMemory } from "@/lib/memory/store";
import { forceFlushSnapshot } from "@/lib/storage/persistent";
import type { MemoryKind } from "@/lib/memory/types";

interface ExtractedMemory {
  kind: MemoryKind;
  content: string;
  entity?: string;
}

// How many characters to process per LLM call.
// Claude's context is large but we want fast responses — 40K chars is ~10K tokens.
const CHUNK_SIZE = 40_000;

// Overlap between chunks so memories spanning a chunk boundary aren't missed.
const CHUNK_OVERLAP = 2_000;

/**
 * Build a strict personal-data-only extraction prompt.
 *
 * Every memory extracted must have THE USER as its subject.
 * Competitive intelligence, market data, company rankings, and third-party
 * metrics are never personal memories — they are rejected regardless of whether
 * the user's employer is mentioned.
 */
function buildPrompt(chunk: string, chunkIndex: number, totalChunks: number): string {
  const chunkNote =
    totalChunks > 1
      ? `\n\n(This is chunk ${chunkIndex + 1} of ${totalChunks}. Apply the same strict rules to this portion.)`
      : "";

  return `You are a personal memory extractor for an AI executive assistant called Basil.

CRITICAL RULE: Every memory you extract MUST have THE USER as its subject. Each item must describe something true and durable about this specific user as an individual. Before extracting anything, ask: "Can I rewrite this as 'The user [verb]...' naturally?" If no — do not extract it.

You may ONLY extract:
1. The user's own identity: name, job title, employer, email, phone, location
2. The user's work tools: software, platforms, and workflows THEY personally use
3. The user's relationships: named colleagues, direct reports, managers, clients, investors — only the person's name and their relationship TO THE USER
4. The user's communication preferences: how THEY like to write, meet, or work
5. The user's active projects: initiatives the user personally owns or contributes to

ABSOLUTE PROHIBITIONS — return [] if the text contains only these:
- Any sentence where the subject is a company, product, ticker, or brand — not the user
- Competitor rankings, deal momentum, win rates, pipeline scores, velocity scores, brand indices
- Market research, industry benchmarks, or intelligence about third-party organisations
- Product feature lists, dashboard capabilities, or platform metrics
- Financial scores, valuation data, or statistics about any company
- Data about what tools or companies DO — only what the user personally uses or prefers
- Content the user is reviewing, reading, or analysing — extract nothing from the document itself

CONCRETE BAD EXAMPLES — never extract these patterns:
✗ "Bloomberg ranks 1st in Deal Momentum (pipeline score 90.5, win rate 67%)" — about Bloomberg
✗ "MORN ranks last in Deal Momentum with win rate 31%" — about Morningstar
✗ "FDS competitors tracked include SPGI, Bloomberg, MSCI, LSEGY, AlphaSense" — competitor list
✗ "AlphaSense ranks 3rd with pipeline score 80.0 and velocity score 64.0" — about AlphaSense
✗ "In Reputation Index, Bloomberg ranks 1st (brand score 89.3)" — brand ranking data
✗ "The dashboard tracks 8 competitors across deal momentum metrics" — tool/dashboard data

CONCRETE GOOD EXAMPLES — only these patterns:
✓ "The user is VP of Sales at TalentGenius" — user's role
✓ "The user uses Slack and Zoom as primary communication tools" — user's tools
✓ "The user's direct manager is Sarah Chen" — user's relationship
✓ "The user prefers bullet-point summaries over prose" — user's preference
✓ "The user is leading the Q3 enterprise expansion initiative" — user's project

Return ONLY a valid JSON array. Each item:
- "kind": one of "fact" | "preference" | "person" | "context"
- "content": short sentence written ABOUT THE USER (max 150 chars)
- "entity": (optional) only when naming the user's employer, a specific person they know, or a project they own

Kind guidelines:
- "fact": durable detail about the user (their role, employer, email, tools they personally use)
- "preference": how the user likes things done
- "person": a named individual in the user's life and their relationship to the user
- "context": an active project or situation the user is personally involved in

If the text contains no information about the user as an individual, return [].
Output ONLY valid JSON — no markdown, no explanation.${chunkNote}

--- TEXT ---
${chunk}
--- END ---`;
}

// ── Server-side content guard ─────────────────────────────────────────────────
// Defense-in-depth filter applied AFTER LLM extraction.
// Catches competitive intelligence and market data that slips through the prompt.

const CI_PATTERNS: RegExp[] = [
  // ── Company as grammatical subject ────────────────────────────────────────
  // Any sentence starting with a company name/ticker is about that company,
  // not the user. Catches: "FDS headwind profile...", "Bloomberg has...", etc.
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

/**
 * Returns true if the memory content looks like competitive intelligence
 * or market data that should never be stored as a personal memory.
 */
function isCompetitiveIntelligence(content: string): boolean {
  return CI_PATTERNS.some((re) => re.test(content));
}

/**
 * Call the LLM on a single chunk and return extracted memories.
 * Returns [] on any failure (errors are logged, not propagated).
 */
async function extractChunk(chunk: string, chunkIndex: number, totalChunks: number): Promise<ExtractedMemory[]> {
  try {
    const result = await generateText({
      model: getTextModel(),
      maxOutputTokens: MAX_TOKENS.default,
      messages: [{ role: "user", content: buildPrompt(chunk, chunkIndex, totalChunks) }],
      providerOptions: {
        gateway: { tags: ["feature:memory-import"] },
      },
    });

    const parseResult = parseAndValidate(result.text, MemoryImportArraySchema, "[memory/import]");
    if (!parseResult.ok) {
      console.error(`[memory/import] Chunk ${chunkIndex + 1}/${totalChunks} validation failed:`, parseResult.error);
      return [];
    }
    return parseResult.data;
  } catch (err) {
    console.error(`[memory/import] Chunk ${chunkIndex + 1}/${totalChunks} extraction error:`, err);
    return [];
  }
}

/**
 * Deduplicate extracted memories: drop items whose content is nearly identical
 * to an already-accepted item (case-insensitive, 80%+ char overlap).
 */
function deduplicateMemories(items: ExtractedMemory[]): ExtractedMemory[] {
  const accepted: ExtractedMemory[] = [];
  for (const item of items) {
    const norm = item.content.trim().toLowerCase();
    const isDupe = accepted.some((a) => {
      const an = a.content.trim().toLowerCase();
      // Simple overlap check: if one string is a substring of the other within 20 chars
      if (an.includes(norm) || norm.includes(an)) return true;
      // Levenshtein-lite: compare word sets
      const wordsA = new Set(an.split(/\s+/).filter((w) => w.length > 3));
      const wordsB = new Set(norm.split(/\s+/).filter((w) => w.length > 3));
      if (wordsA.size === 0 || wordsB.size === 0) return false;
      let shared = 0;
      for (const w of wordsA) if (wordsB.has(w)) shared++;
      return shared / Math.min(wordsA.size, wordsB.size) > 0.8;
    });
    if (!isDupe) accepted.push(item);
  }
  return accepted;
}

// 500 KB limit — large enough for full documents, prevents abuse
const MAX_BODY_BYTES = 500_000;

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  // Enforce body size before parsing to avoid memory exhaustion
  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Request body too large (max 500 KB)" }, { status: 413 });
  }

  let text: string;
  try {
    ({ text } = await req.json());
    if (!text || typeof text !== "string" || text.trim().length < 10) throw new Error();
    if (text.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Text too large (max 500 KB)" }, { status: 413 });
    }
  } catch {
    return NextResponse.json({ error: "Provide non-empty text to analyse" }, { status: 400 });
  }

  const trimmed = text.trim();

  // ── Split into chunks ───────────────────────────────────────────────────────
  const chunks: string[] = [];
  if (trimmed.length <= CHUNK_SIZE) {
    chunks.push(trimmed);
  } else {
    let pos = 0;
    while (pos < trimmed.length) {
      const end = Math.min(pos + CHUNK_SIZE, trimmed.length);
      chunks.push(trimmed.slice(pos, end));
      pos += CHUNK_SIZE - CHUNK_OVERLAP;
    }
  }

  console.log(`[memory/import] Processing ${trimmed.length} chars in ${chunks.length} chunk(s)`);

  // ── Extract from each chunk ─────────────────────────────────────────────────
  // Process chunks sequentially to avoid hammering the gateway
  const allExtracted: ExtractedMemory[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const results = await extractChunk(chunks[i], i, chunks.length);
    allExtracted.push(...results);
  }

  if (allExtracted.length === 0) {
    return NextResponse.json({ imported: 0, memories: [] });
  }

  // ── Server-side content guard ───────────────────────────────────────────────
  // Removes competitive intelligence and market data that slipped past the prompt.
  const filtered = allExtracted.filter((m) => {
    if (m.kind === "fact" && isCompetitiveIntelligence(m.content)) {
      console.log(`[memory/import] Rejected CI memory: "${m.content.slice(0, 80)}"`);
      return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    return NextResponse.json({ imported: 0, memories: [] });
  }

  // ── Deduplicate across chunks ───────────────────────────────────────────────
  const deduped = deduplicateMemories(filtered);

  // ── Save to store ───────────────────────────────────────────────────────────
  const saved = await Promise.all(
    deduped.map((m) =>
      createMemory(username, {
        kind: m.kind,
        content: m.content.trim(),
        entity: m.entity?.trim() || undefined,
        source: "manual",
      })
    )
  );

  console.log(`[memory/import] Extracted ${allExtracted.length}, deduped to ${deduped.length}, saved ${saved.length}`);

  // Flush snapshot so BASIL_DATA is current before the client re-fetches.
  // Without this, memories are lost when the Vercel function instance recycles.
  await forceFlushSnapshot();

  return NextResponse.json({ imported: saved.length, memories: saved });
}
