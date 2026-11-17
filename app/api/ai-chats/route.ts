/**
 * GET /api/ai-chats             — what Basil has read from Claude and ChatGPT (counts, last sync, latest work conversations)
 * GET /api/ai-chats?q=pricing   — search the user's work conversations
 * GET /api/ai-chats?seen=1      — key → last-changed date of everything already read (for the sync script)
 *
 * Session or the user's bsl_ token (Settings → Developer).
 */
import { NextResponse } from "next/server";
import { getStigRequestUser } from "@/lib/stig/auth";
import { chatStatus, searchAIChats, seenConversations } from "@/lib/ai-chats/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await getStigRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const url = new URL(req.url);

  if (url.searchParams.get("seen") === "1") {
    return NextResponse.json({ seen: await seenConversations(user.username) });
  }
  const q = url.searchParams.get("q")?.trim();
  if (q) {
    return NextResponse.json({ query: q, results: await searchAIChats(user.username, q.slice(0, 200)) });
  }
  return NextResponse.json(await chatStatus(user.username));
}
