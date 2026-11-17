/**
 * Conversations from Claude.ai and ChatGPT, in one shape.
 *
 * Both apps return the same structures from their own web APIs (what the user's
 * logged-in browser reads, scripts/basil-ai-chats.mjs) and in their official
 * data exports, so one parser serves either source. Pure — tested in
 * tests/ai-chats.test.mjs.
 */

export type ChatPlatform = "claude-chat" | "chatgpt";
export const CHAT_PLATFORMS: ChatPlatform[] = ["claude-chat", "chatgpt"];

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  at?: string;
}

export interface ChatTranscript {
  platform: ChatPlatform;
  id: string;
  title: string;
  createdAt?: string;
  updatedAt: string;
  url: string;
  messages: ChatMessage[];
}

/** One message is cut here; a long pasted document says little more past it. */
const MAX_MESSAGE_CHARS = 4_000;
/** Messages kept per conversation (the latest ones when there are more). */
const MAX_MESSAGES = 200;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** Seconds since 1970 (ChatGPT) or an ISO string (Claude) → ISO. */
function iso(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return new Date(v * 1000).toISOString();
  const s = str(v);
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

function clean(text: string): string {
  const t = text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > MAX_MESSAGE_CHARS ? `${t.slice(0, MAX_MESSAGE_CHARS)}…` : t;
}

function finish(t: Omit<ChatTranscript, "messages">, messages: ChatMessage[]): ChatTranscript | null {
  const kept = messages.filter((m) => m.text).slice(-MAX_MESSAGES);
  if (kept.length === 0 || !t.id) return null;
  return { ...t, messages: kept };
}

/**
 * A Claude.ai conversation: `chat_messages` with `sender` "human" | "assistant"
 * and the words in `text`, or in `content` blocks of type "text" (newer
 * conversations, and tool use, carry the words only there).
 */
export function fromClaude(conv: unknown): ChatTranscript | null {
  if (!isObj(conv)) return null;
  const id = str(conv.uuid) ?? str(conv.id);
  if (!id) return null;
  const raw = Array.isArray(conv.chat_messages) ? conv.chat_messages : [];
  const messages: ChatMessage[] = [];
  for (const m of raw) {
    if (!isObj(m)) continue;
    const role = m.sender === "human" ? "user" : m.sender === "assistant" ? "assistant" : null;
    if (!role) continue;
    const blocks = Array.isArray(m.content)
      ? m.content.filter(isObj).filter((b) => b.type === "text").map((b) => str(b.text) ?? "").join("\n")
      : "";
    const text = clean(blocks || str(m.text) || "");
    if (text) messages.push({ role, text, at: iso(m.created_at) });
  }
  const updatedAt = iso(conv.updated_at) ?? iso(conv.created_at) ?? messages.at(-1)?.at ?? new Date(0).toISOString();
  return finish({
    platform: "claude-chat",
    id,
    title: str(conv.name)?.trim() || "Untitled conversation",
    createdAt: iso(conv.created_at),
    updatedAt,
    url: `https://claude.ai/chat/${id}`,
  }, messages);
}

/**
 * A ChatGPT conversation: messages live in a `mapping` tree, because editing a
 * message branches the conversation. The branch the user last saw is the path
 * from `current_node` back to the root, so that is the one read. Exports
 * without `current_node` fall back to the latest leaf.
 */
export function fromChatGPT(conv: unknown): ChatTranscript | null {
  if (!isObj(conv)) return null;
  const id = str(conv.conversation_id) ?? str(conv.id);
  const mapping = isObj(conv.mapping) ? conv.mapping : null;
  if (!id || !mapping) return null;

  let node = str(conv.current_node);
  if (!node || !isObj(mapping[node])) {
    // Latest node with no children.
    let best: { key: string; at: number } | null = null;
    for (const [key, n] of Object.entries(mapping)) {
      if (!isObj(n) || (Array.isArray(n.children) && n.children.length > 0)) continue;
      const at = isObj(n.message) && typeof n.message.create_time === "number" ? n.message.create_time : 0;
      if (!best || at >= best.at) best = { key, at };
    }
    node = best?.key;
  }

  const path: ChatMessage[] = [];
  const seen = new Set<string>();
  while (node && isObj(mapping[node]) && !seen.has(node)) {
    seen.add(node);
    const n = mapping[node] as Record<string, unknown>;
    const msg = isObj(n.message) ? n.message : null;
    const author = msg && isObj(msg.author) ? msg.author.role : undefined;
    const role = author === "user" ? "user" : author === "assistant" ? "assistant" : null;
    const content = msg && isObj(msg.content) ? msg.content : null;
    // Only plain text: tool calls, code runs, browsing and images carry no prose to keep.
    if (role && content && (content.content_type === "text" || content.content_type === "multimodal_text") && Array.isArray(content.parts)) {
      const text = clean(content.parts.map((p) => (typeof p === "string" ? p : isObj(p) && typeof p.text === "string" ? p.text : "")).join("\n"));
      const hidden = isObj(msg?.metadata) && msg.metadata.is_visually_hidden_from_conversation === true;
      if (text && !hidden) path.push({ role, text, at: iso(msg?.create_time) });
    }
    node = str(n.parent);
  }
  const messages = path.reverse();
  return finish({
    platform: "chatgpt",
    id,
    title: str(conv.title)?.trim() || "Untitled conversation",
    createdAt: iso(conv.create_time),
    updatedAt: iso(conv.update_time) ?? iso(conv.create_time) ?? messages.at(-1)?.at ?? new Date(0).toISOString(),
    url: `https://chatgpt.com/c/${id}`,
  }, messages);
}

export function parseConversation(platform: ChatPlatform, conv: unknown): ChatTranscript | null {
  return platform === "claude-chat" ? fromClaude(conv) : fromChatGPT(conv);
}

/** Stable store key. */
export const chatKey = (t: Pick<ChatTranscript, "platform" | "id">): string => `${t.platform}:${t.id}`;

/**
 * What the model reads to judge a conversation: the title, then the user's own
 * words first (they say what the conversation is about and who is involved),
 * then the assistant's answers, all within `budget` characters.
 */
export function readingText(t: ChatTranscript, budget = 8_000): string {
  const out: string[] = [`Title: ${t.title}`];
  let left = budget - out[0].length;
  const take = (prefix: string, text: string, cap: number) => {
    if (left <= 0) return;
    const piece = `${prefix}${text.slice(0, Math.min(cap, left))}`;
    out.push(piece);
    left -= piece.length;
  };
  for (const m of t.messages.filter((m) => m.role === "user")) take("Me: ", m.text, 1_500);
  for (const m of t.messages.filter((m) => m.role === "assistant")) take("AI: ", m.text, 600);
  return out.join("\n");
}
