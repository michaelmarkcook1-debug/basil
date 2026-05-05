import { NextResponse } from "next/server";
import { getSnapshot, deleteSnapshot } from "@/lib/whatsapp/dump-job";
import { getSessionUser } from "@/lib/auth";

// GET /api/whatsapp/snapshot — returns metadata + chat list (without messages)
// so the list view is cheap. Clients fetch full chats via ?chatId=… below.
export async function GET(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const url = new URL(req.url);
  const chatId = url.searchParams.get("chatId");

  const snapshot = await getSnapshot(username);
  if (!snapshot) {
    return NextResponse.json({ snapshot: null });
  }

  if (chatId) {
    const chat = snapshot.chats.find((c) => c.id === chatId);
    if (!chat) return NextResponse.json({ error: "chat not found" }, { status: 404 });
    return NextResponse.json({ chat });
  }

  // Strip messages from the list payload — keeps the response small.
  const lightChats = snapshot.chats.map((c) => ({
    id: c.id,
    name: c.name,
    isGroup: c.isGroup,
    unreadCount: c.unreadCount,
    lastMessageAt: c.lastMessageAt,
    lastMessagePreview: c.lastMessagePreview,
    messageCount: c.messageCount,
  }));

  return NextResponse.json({
    snapshot: {
      capturedAt: snapshot.capturedAt,
      chatCount: snapshot.chatCount,
      messageCount: snapshot.messageCount,
      contactCount: snapshot.contactCount,
      meJid: snapshot.meJid,
      meName: snapshot.meName,
      chats: lightChats,
    },
  });
}

// DELETE /api/whatsapp/snapshot — drop the stored snapshot
export async function DELETE() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  await deleteSnapshot(username);
  return NextResponse.json({ status: "deleted" });
}
