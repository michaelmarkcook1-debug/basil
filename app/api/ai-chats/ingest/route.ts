/**
 * POST /api/ai-chats/ingest — conversations from the user's Claude.ai or
 * ChatGPT, sent by scripts/basil-ai-chats.mjs running in their logged-in Chrome.
 *
 *   Authorization: Bearer bsl_…   (the token from Settings → Developer; a session also works)
 *   { platform: "claude-chat" | "chatgpt", conversations: [ <the app's own conversation JSON>, … ] }
 *
 * Each conversation is read once per change: work ones are summarised and kept,
 * personal ones are recorded as seen with nothing else stored (lib/ai-chats).
 * At most 25 conversations per request.
 */
import { NextResponse } from "next/server";
import { getStigRequestUser } from "@/lib/stig/auth";
import { SpendCapError } from "@/lib/ai/spend-guard";
import { CHAT_PLATFORMS, chatKey, parseConversation, type ChatPlatform, type ChatTranscript } from "@/lib/ai-chats/parse";
import { digestConversation, type ChatDigest } from "@/lib/ai-chats/digest";
import { saveDigests, seenConversations, touchSync } from "@/lib/ai-chats/store";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_PER_REQUEST = 25;
const CONCURRENCY = 4;

export async function POST(req: Request) {
  const user = await getStigRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const username = user.username;

  const body = await req.json().catch((e) => {
    console.warn("[ai-chats/ingest] unreadable body:", e instanceof Error ? e.message : e);
    return null;
  }) as { platform?: unknown; conversations?: unknown } | null;
  const platform = body?.platform as ChatPlatform;
  if (!CHAT_PLATFORMS.includes(platform)) {
    return NextResponse.json({ error: `platform must be one of ${CHAT_PLATFORMS.join(", ")}` }, { status: 400 });
  }
  if (!Array.isArray(body?.conversations)) return NextResponse.json({ error: "conversations must be an array" }, { status: 400 });
  if (body.conversations.length > MAX_PER_REQUEST) {
    return NextResponse.json({ error: `At most ${MAX_PER_REQUEST} conversations per request` }, { status: 400 });
  }

  const seen = await seenConversations(username);
  const fresh: ChatTranscript[] = [];
  let unreadable = 0;
  let unchanged = 0;
  for (const raw of body.conversations) {
    const t = parseConversation(platform, raw);
    if (!t) { unreadable++; continue; }
    if (seen[chatKey(t)] === t.updatedAt) { unchanged++; continue; }
    fresh.push(t);
  }

  const done: Array<{ t: ChatTranscript; digest: ChatDigest }> = [];
  let failed = 0;
  let capReached: SpendCapError | null = null;
  for (let i = 0; i < fresh.length && !capReached; i += CONCURRENCY) {
    const batch = fresh.slice(i, i + CONCURRENCY);
    const out = await Promise.allSettled(batch.map((t) => digestConversation(username, t)));
    out.forEach((r, j) => {
      if (r.status === "fulfilled" && r.value) done.push({ t: batch[j], digest: r.value });
      else if (r.status === "rejected" && r.reason instanceof SpendCapError) capReached = r.reason;
      else failed++; // not recorded, so the next sync reads it again
    });
  }

  if (done.length > 0) await saveDigests(username, platform, done);
  else await touchSync(username, platform);

  const result = {
    platform,
    received: body.conversations.length,
    read: done.length,
    work: done.filter((d) => d.digest.work).length,
    personal: done.filter((d) => !d.digest.work).length,
    unchanged,
    unreadable,
    failed,
  };
  if (capReached) {
    // Stop the script cleanly; what was read is kept.
    return NextResponse.json({ ...result, stopped: "daily AI limit reached", error: (capReached as SpendCapError).message }, { status: 429 });
  }
  return NextResponse.json(result);
}
