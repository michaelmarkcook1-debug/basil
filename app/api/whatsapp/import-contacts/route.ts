import { NextResponse } from "next/server";
import { getSnapshot } from "@/lib/whatsapp/dump-job";

// GET /api/whatsapp/import-contacts — returns a preview list of WhatsApp
// contacts that could be added to the Personal directory. Client-side code
// writes them into localStorage via lib/user-contacts.ts (server has no access
// to that store), so this route is read-only.
export async function GET() {
  const snapshot = await getSnapshot();
  if (!snapshot) {
    return NextResponse.json(
      { error: "No snapshot yet — import WhatsApp first" },
      { status: 404 }
    );
  }

  // Build a clean contact list:
  //   - Skip groups (jid ends with @g.us)
  //   - Prefer contact.name, fall back to pushName, then phone
  //   - Skip anyone without a display name AND without a phone
  //   - Skip the linked account itself
  const candidates = snapshot.contacts
    .filter((c) => c.id.endsWith("@s.whatsapp.net") && c.id !== snapshot.meJid)
    .map((c) => {
      const displayName = c.name || c.pushName || c.notify || c.phoneNumber || "";
      return {
        jid: c.id,
        name: displayName.trim(),
        phone: c.phoneNumber,
        lastMessageAt: snapshot.chats.find((ch) => ch.id === c.id)?.lastMessageAt,
      };
    })
    .filter((c) => c.name || c.phone)
    // Prefer contacts we have at least one chat with — those are real people
    // Michael has talked to, not just every random contact on his phone.
    .map((c) => ({
      ...c,
      hasChat: snapshot.chats.some((ch) => ch.id === c.jid),
    }));

  const withChat = candidates.filter((c) => c.hasChat);
  const noChat = candidates.filter((c) => !c.hasChat);

  return NextResponse.json({
    capturedAt: snapshot.capturedAt,
    withChat,
    noChat,
  });
}
