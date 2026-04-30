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

import { NextResponse } from "next/server";
import { generateText } from "ai";
import { getSessionUser } from "@/lib/auth";
import { createMemory } from "@/lib/memory/store";
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
 * Build a prompt that works for both AI conversations AND plain documents/files.
 * The key insight: we want facts, preferences, context, and people — regardless
 * of whether the source is a chat transcript or a project document.
 */
function buildPrompt(chunk: string, chunkIndex: number, totalChunks: number): string {
  const chunkNote =
    totalChunks > 1
      ? `\n\n(This is chunk ${chunkIndex + 1} of ${totalChunks}. Apply the same strict rules to this portion.)`
      : "";

  return `You are a personal memory extractor for an AI executive assistant called Basil.

Your job: extract facts ABOUT THE USER — their identity, role, relationships, tools, and preferences. Nothing else.

Personal memory is strictly limited to:
1. Facts about the user themselves: their name, job title, company they work for, email, location, contact details
2. Their work environment: tools and software they use day-to-day, communication platforms, workflows
3. Their work relationships: colleagues, direct reports, clients, investors — who they are and how they relate to the user
4. Their personal preferences: how they like to communicate, work, format documents, run meetings
5. Their active projects and goals: things the user is personally working on or responsible for

DO NOT extract any of the following — return [] if the text contains only these:
- Market research, competitive intelligence, or industry rankings (e.g. "Bloomberg ranks 1st in deal momentum")
- Data about companies the user doesn't work for, even if they're analysing them
- Product features, dashboards, or capabilities of tools/platforms being described
- Financial data, scores, metrics, or statistics about third parties
- General business facts that aren't about the user personally
- Content the user is reading, researching, or reviewing — only extract what it reveals ABOUT THE USER

The test: ask "Does this tell me something durable about the user as a person or professional?" If no, skip it.

Return ONLY a valid JSON array. Each item must have:
- "kind": one of "fact" | "preference" | "person" | "context"
- "content": a short, specific, self-contained sentence written about the user (max 150 chars)
- "entity": (optional) the specific person, company they work for, or project name — only when relevant

Kind guidelines:
- "fact": durable detail about the user (their role, employer, email, tools they personally use)
- "preference": how the user likes things done (communication style, meeting format, tool choices)
- "person": a specific named individual in the user's professional or personal life, and what the user knows about them
- "context": an active project or ongoing situation the user is personally involved in

If the text contains no information about the user as a person or professional, return [].
Output ONLY valid JSON — no markdown fences, no explanation.${chunkNote}

--- TEXT ---
${chunk}
--- END ---`;
}

/**
 * Call the LLM on a single chunk and return extracted memories.
 * Returns [] on any failure (errors are logged, not propagated).
 */
async function extractChunk(chunk: string, chunkIndex: number, totalChunks: number): Promise<ExtractedMemory[]> {
  const validKinds = new Set<string>(["fact", "preference", "person", "context"]);

  try {
    const result = await generateText({
      model: "anthropic/claude-sonnet-4.6",
      messages: [{ role: "user", content: buildPrompt(chunk, chunkIndex, totalChunks) }],
      providerOptions: {
        gateway: { tags: ["feature:memory-import"] },
      },
    });

    // Strip markdown code fences if the model wraps the JSON anyway
    const raw = result.text
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.error("[memory/import] LLM returned non-array:", raw.slice(0, 200));
      return [];
    }

    return parsed.filter(
      (m) =>
        m &&
        typeof m.content === "string" &&
        m.content.trim().length > 0 &&
        validKinds.has(m.kind)
    );
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

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  let text: string;
  try {
    ({ text } = await req.json());
    if (!text || typeof text !== "string" || text.trim().length < 10) throw new Error();
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

  // ── Deduplicate across chunks ───────────────────────────────────────────────
  const deduped = deduplicateMemories(allExtracted);

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

  return NextResponse.json({ imported: saved.length, memories: saved });
}
