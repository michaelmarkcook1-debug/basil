import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getChatHistory, appendChatMessages, clearChatHistory } from "@/lib/chat/store";
import type { StoredMessage } from "@/lib/chat/store";

/** Default recall window — recent enough to be relevant, small enough to be cheap. */
const DEFAULT_DAYS = 14;
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 200;

/**
 * GET /api/chat/history?days=14&limit=40&q=kyndryl
 *
 * Returns a WINDOW of history, not the whole archive.
 *
 * Loading everything was wrong twice over: it dragged up to 200 messages of
 * unrelated conversation into the thread, and every one of those is then resent
 * to the model on every subsequent turn — paying tokens (and latency) to carry
 * months of irrelevant context.
 *
 * - `days`  — date window, newest-first (default 14).
 * - `limit` — hard cap after the date filter (default 40, max 200).
 * - `q`     — optional context filter; keeps only messages mentioning the term,
 *             for pulling one past thread back without the rest.
 *
 * `total` is always the full archive size so the UI can honestly say what it is
 * NOT showing — a silent truncation would read as "this is all your history".
 */
export async function GET(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const days = Math.max(1, Math.min(365, Number(searchParams.get("days")) || DEFAULT_DAYS));
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number(searchParams.get("limit")) || DEFAULT_LIMIT));
  const q = (searchParams.get("q") ?? "").trim().toLowerCase();

  const all = await getChatHistory(username);
  const cutoff = Date.now() - days * 86_400_000;

  let windowed = all.filter((m) => {
    const t = new Date(m.createdAt).getTime();
    // Undated legacy rows are kept rather than silently dropped — losing real
    // history to a missing field would be worse than showing a little extra.
    return !Number.isFinite(t) || t >= cutoff;
  });

  if (q) {
    windowed = windowed.filter((m) => m.content.toLowerCase().includes(q));
  }

  // Newest-first cap, then restore chronological order for rendering.
  const capped = windowed.slice(Math.max(0, windowed.length - limit));

  return NextResponse.json({
    messages: capped,
    total: all.length,
    returned: capped.length,
    window: { days, limit, q: q || undefined },
    truncated: capped.length < all.length,
  });
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

// Saving is ALWAYS an idempotent append now. The old "replace" mode
// (clear-then-write) silently wiped the entire archive whenever a fresh session
// saved its first exchange — the chat-history data-loss bug. PUT is kept only for
// backwards-compat and behaves identically to POST. Permanent deletion is the
// explicit DELETE handler only, never a side effect of saving.
async function saveMessages(req: Request, _forceReplace: boolean) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  let messages: StoredMessage[];

  try {
    const body = await req.json();
    messages = body.messages;
    if (!Array.isArray(messages)) throw new Error("messages must be an array");
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  // Sanitise: only store user/assistant messages with text content OR at least
  // one tool receipt (a tool-only assistant turn — e.g. just booking a meeting —
  // has no text but is still real, storable history).
  const safe: StoredMessage[] = messages
    .filter((m) =>
      (m.role === "user" || m.role === "assistant") &&
      typeof m.content === "string" &&
      (m.content.trim() || (Array.isArray(m.toolReceipts) && m.toolReceipts.length > 0))
    )
    .map((m) => {
      const toolReceipts = Array.isArray(m.toolReceipts)
        ? (m.toolReceipts as Array<{ toolName?: unknown; state?: unknown; input?: unknown }>)
            .filter((r) => !!r && typeof r === "object" && typeof r.toolName === "string" && typeof r.state === "string")
            .slice(0, 20) // a single turn calling 20+ tools is pathological — cap defensively
            .map((r) => ({ toolName: r.toolName as string, state: r.state as string, input: r.input }))
        : undefined;
      return {
        id: m.id ?? crypto.randomUUID(),
        role: m.role,
        content: m.content,
        createdAt: m.createdAt ?? new Date().toISOString(),
        ...(toolReceipts && toolReceipts.length > 0 ? { toolReceipts } : {}),
      };
    });

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
