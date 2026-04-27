/**
 * POST /api/memory/import
 *
 * Accepts a block of conversation text (from ChatGPT, Claude.ai, Gemini, etc.)
 * and uses Claude to extract structured memories from it, then saves them.
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

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  let text: string;
  try {
    ({ text } = await req.json());
    if (!text || typeof text !== "string" || text.trim().length < 20) throw new Error();
  } catch {
    return NextResponse.json({ error: "Provide a non-empty conversation text" }, { status: 400 });
  }

  const prompt = `You are extracting durable personal memories from a conversation with an AI assistant.

Read the conversation below and extract every distinct, reusable memory about the user — things that would help a personal executive assistant serve them better in the future.

Return ONLY a JSON array of objects. Each object must have:
- "kind": one of "fact" | "preference" | "person" | "context"
- "content": a short, specific, decontextualised sentence (max 120 chars)
- "entity": (optional) the person, company, or project this is about

Guidelines:
- "fact": durable verifiable detail about the user (role, company, location, family, etc.)
- "preference": how the user likes things done (communication style, tool preferences, work habits)
- "person": something learned about a specific person in the user's network
- "context": an active project, goal, or ongoing situation

Ignore filler, small talk, and AI responses. Only extract things about the USER.
If nothing meaningful can be extracted, return an empty array [].

Output ONLY valid JSON — no markdown, no explanation.

--- CONVERSATION ---
${text.slice(0, 12000)}
--- END ---`;

  let extracted: ExtractedMemory[] = [];
  try {
    const result = await generateText({
      model: "anthropic/claude-sonnet-4.6",
      messages: [{ role: "user", content: prompt }],
      providerOptions: {
        gateway: { tags: ["feature:memory-import"] },
      },
    });

    const raw = result.text.trim().replace(/^```json\s*/i, "").replace(/```\s*$/, "");
    extracted = JSON.parse(raw);
    if (!Array.isArray(extracted)) throw new Error("Not an array");

    // Validate and sanitise each entry
    const validKinds = new Set<string>(["fact", "preference", "person", "context"]);
    extracted = extracted.filter(
      (m) =>
        m &&
        typeof m.content === "string" &&
        m.content.trim().length > 0 &&
        validKinds.has(m.kind)
    );
  } catch (e) {
    console.error("[memory/import] Extraction failed:", e);
    return NextResponse.json({ error: "Failed to extract memories from the text" }, { status: 500 });
  }

  if (extracted.length === 0) {
    return NextResponse.json({ imported: 0, memories: [] });
  }

  const saved = await Promise.all(
    extracted.map((m) =>
      createMemory(username, {
        kind: m.kind,
        content: m.content.trim(),
        entity: m.entity?.trim() || undefined,
        source: "manual",
      })
    )
  );

  console.log(`[memory/import] Imported ${saved.length} memories for ${username}`);
  return NextResponse.json({ imported: saved.length, memories: saved });
}
