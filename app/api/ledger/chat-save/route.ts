/**
 * POST /api/ledger/chat-save
 *
 * Saves a chat message snippet directly to the actions or memory store.
 * Used by the "→ Action" and "→ Memory" buttons on assistant message cards.
 */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { createAction } from "@/lib/actions/store";
import { createMemory } from "@/lib/memory/store";
import { forceFlushSnapshot } from "@/lib/storage/persistent";

export const dynamic = "force-dynamic";

interface ChatSaveBody {
  type: "action" | "memory";
  content: string;
  messageId?: string;
}

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  let body: ChatSaveBody;
  try {
    body = await req.json() as ChatSaveBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { type, content, messageId } = body;

  if (!type || !["action", "memory"].includes(type)) {
    return NextResponse.json({ error: "type must be 'action' or 'memory'" }, { status: 400 });
  }
  if (!content?.trim()) {
    return NextResponse.json({ error: "content is required" }, { status: 400 });
  }

  const sourceRef = messageId ? `chat:${messageId}` : undefined;
  const trimmed = content.trim().slice(0, 2000); // guard against huge pastes

  try {
    if (type === "action") {
      const action = await createAction(username, {
        text: trimmed,
        source: "manual",
        sourceRef,
        priority: "medium",
      });
      await forceFlushSnapshot();
      return NextResponse.json({ ok: true, id: action.id, type: "action" });
    }

    // type === "memory"
    const memory = await createMemory(username, {
      kind: "fact",
      content: trimmed,
      source: "chat",
      sourceRef,
    });
    await forceFlushSnapshot();
    return NextResponse.json({ ok: true, id: memory.id, type: "memory" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[ledger/chat-save] error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
