import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getChatHistory, appendChatMessages, clearChatHistory } from "@/lib/chat/store";
import type { StoredMessage } from "@/lib/chat/store";

/**
 * GET /api/chat/history
 * Returns the stored chat history for the authenticated user.
 */
export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const messages = await getChatHistory(username);
  return NextResponse.json({ messages });
}

/**
 * POST /api/chat/history
 * Appends new messages to the user's chat history (mobile usage).
 * Body: { messages: StoredMessage[] }
 *
 * PUT /api/chat/history  (handled by same function with replace=true)
 * Replaces the entire chat history (web usage — sends full message list).
 * Body: { messages: StoredMessage[], replace?: boolean }
 */
export async function POST(req: Request) {
  return saveMessages(req, false);
}

export async function PUT(req: Request) {
  return saveMessages(req, true);
}

async function saveMessages(req: Request, forceReplace: boolean) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  let messages: StoredMessage[];
  let replace = forceReplace;

  try {
    const body = await req.json();
    messages = body.messages;
    if (!forceReplace && body.replace === true) replace = true;
    if (!Array.isArray(messages)) throw new Error("messages must be an array");
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  // Sanitise: only store user/assistant messages with text content
  const safe: StoredMessage[] = messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({
      id: m.id ?? crypto.randomUUID(),
      role: m.role,
      content: m.content,
      createdAt: m.createdAt ?? new Date().toISOString(),
    }));

  if (replace) {
    await clearChatHistory(username);
  }
  await appendChatMessages(username, safe);
  return NextResponse.json({ ok: true, saved: safe.length });
}

/**
 * DELETE /api/chat/history
 * Clears the user's entire chat history.
 */
export async function DELETE() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  await clearChatHistory(username);
  return NextResponse.json({ ok: true });
}
