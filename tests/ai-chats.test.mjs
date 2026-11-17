// Context from Claude and ChatGPT (2026-11-10): "for further Basil context can
// you get it to check my AI agents (claude and chatgpt) — I often discuss topics
// in these apps". Basil only ever stored conversation TITLES from those apps, and
// never read a word of them. Now scripts/basil-ai-chats.mjs reads conversations
// through the user's logged-in Chrome; Basil keeps work ones (a digest and an
// excerpt) and stores nothing from personal ones — the user chose "work only".
import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./_helpers/load-ts.mjs";

const P = loadTs("lib/ai-chats/parse.ts");
const S = loadTs("lib/ai-chats/search.ts");

// ── The two apps' shapes ─────────────────────────────────────────────────────

const claudeConv = {
  uuid: "c-1",
  name: "AnalystGenius pricing",
  created_at: "2026-11-01T10:00:00.000000Z",
  updated_at: "2026-11-02T09:30:00.123456Z",
  chat_messages: [
    { sender: "human", text: "Help me price AnalystGenius for Deloitte", created_at: "2026-11-01T10:00:00Z" },
    // Newer messages carry the words only in content blocks; tool blocks carry none.
    { sender: "assistant", text: "", content: [{ type: "tool_use", name: "x" }, { type: "text", text: "Start at £40k a year." }] },
    { sender: "system", text: "ignored" },
  ],
};

const chatgptConv = {
  conversation_id: "g-1",
  title: "Board deck outline",
  create_time: 1793800000,
  update_time: 1793900000.5,
  current_node: "n4",
  mapping: {
    root: { id: "root", parent: null, children: ["n1"], message: null },
    n1: { id: "n1", parent: "root", children: ["n2", "n2b"], message: { author: { role: "user" }, content: { content_type: "text", parts: ["Outline the Q4 board deck"] }, create_time: 1793800001 } },
    // The user edited their reply; n2b is the abandoned branch.
    n2b: { id: "n2b", parent: "n1", children: [], message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["OLD BRANCH"] } } },
    n2: { id: "n2", parent: "n1", children: ["n3"], message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["1. Results 2. Pipeline"] } } },
    n3: { id: "n3", parent: "n2", children: ["n4"], message: { author: { role: "tool" }, content: { content_type: "code", text: "print(1)" } } },
    n4: { id: "n4", parent: "n3", children: [], message: { author: { role: "user" }, content: { content_type: "text", parts: ["Add a hiring slide"] }, metadata: {} } },
  },
};

test("a Claude conversation: human and assistant turns, words from text or content blocks", () => {
  const t = P.fromClaude(claudeConv);
  assert.equal(t.platform, "claude-chat");
  assert.equal(t.url, "https://claude.ai/chat/c-1");
  assert.equal(t.updatedAt, "2026-11-02T09:30:00.123Z");
  assert.equal(JSON.stringify(t.messages.map((m) => [m.role, m.text])), JSON.stringify([
    ["user", "Help me price AnalystGenius for Deloitte"],
    ["assistant", "Start at £40k a year."],
  ]));
  assert.equal(P.fromClaude({ uuid: "x", chat_messages: [] }), null, "nothing said, nothing kept");
  assert.equal(P.fromClaude("nope"), null);
});

test("a ChatGPT conversation follows the branch the user last saw, skipping tools and edits", () => {
  const t = P.fromChatGPT(chatgptConv);
  assert.equal(t.url, "https://chatgpt.com/c/g-1");
  assert.equal(t.updatedAt, new Date(1793900000500).toISOString());
  assert.equal(JSON.stringify(t.messages.map((m) => m.text)), JSON.stringify(["Outline the Q4 board deck", "1. Results 2. Pipeline", "Add a hiring slide"]));
});

test("an exported ChatGPT conversation without current_node reads its latest leaf", () => {
  const { current_node: _c, ...exported } = chatgptConv;
  const t = P.fromChatGPT({ ...exported, id: "g-1" });
  assert.equal(t.messages.at(-1).text, "Add a hiring slide");
  assert.ok(!t.messages.some((m) => m.text === "OLD BRANCH"));
});

test("long messages are cut and only the latest 200 kept", () => {
  const many = Array.from({ length: 250 }, (_, i) => ({ sender: i % 2 ? "assistant" : "human", text: `m${i} ` + "x".repeat(5_000) }));
  const t = P.fromClaude({ uuid: "big", name: "big", updated_at: "2026-11-01T00:00:00Z", chat_messages: many });
  assert.equal(t.messages.length, 200);
  assert.ok(t.messages[0].text.startsWith("m50 "));
  assert.ok(t.messages[0].text.length <= 4_001);
});

test("what the model reads puts the user's own words first, within the budget", () => {
  const t = P.fromChatGPT(chatgptConv);
  const text = P.readingText(t, 200);
  assert.ok(text.startsWith("Title: Board deck outline"));
  assert.ok(text.indexOf("Me: Add a hiring slide") < (text.indexOf("AI: ") === -1 ? Infinity : text.indexOf("AI: ")));
  assert.ok(text.length <= 200 + 20);
});

// ── Search ───────────────────────────────────────────────────────────────────

const entries = [
  { key: "claude-chat:c-1", platform: "claude-chat", id: "c-1", updatedAt: "2026-11-02T09:30:00.000Z", work: true, title: "AnalystGenius pricing", url: "u1", summary: "Michael priced AnalystGenius for Deloitte.", people: ["Franz Gilbert"], companies: ["Deloitte"], topics: ["pricing"], decisions: ["Start at £40k"], openItems: [] },
  { key: "chatgpt:g-1", platform: "chatgpt", id: "g-1", updatedAt: "2026-11-05T00:00:00.000Z", work: true, title: "Board deck outline", url: "u2", summary: "Q4 board deck.", people: [], companies: [], topics: ["board"], decisions: [], openItems: ["Add a hiring slide"] },
  { key: "chatgpt:p-1", platform: "chatgpt", id: "p-1", updatedAt: "2026-11-06T00:00:00.000Z", work: false },
];
const excerpts = { "chatgpt:g-1": "Outline the Q4 board deck with Deloitte pipeline numbers" };

test("search finds work conversations by name, topic or words; strong matches first", () => {
  const hits = S.searchChats(entries, excerpts, "Deloitte");
  assert.equal(JSON.stringify(hits.map((h) => h.title)), JSON.stringify(["AnalystGenius pricing", "Board deck outline"]), "a company match beats a match in the words");
  assert.match(hits[1].snippet, /Deloitte pipeline/);
  assert.equal(S.searchChats(entries, excerpts, "deloitte physio").length, 0, "every word must appear in one conversation");
  assert.equal(S.searchChats(entries, excerpts, "deloitte hiring").length, 1, "…and may be spread across its digest and words");
  assert.equal(S.searchChats(entries, excerpts, "the and of").length, 0);
});

test("personal conversations are never searchable — they hold nothing to search", () => {
  assert.ok(S.searchChats(entries, excerpts, "p-1").every((h) => h.url !== ""));
  assert.ok(!S.searchChats(entries, { "chatgpt:p-1": "doctor" }, "doctor").length);
});

test("conversations about a person or company, for briefings and meeting prep", () => {
  const about = S.chatsAbout(entries, ["Franz Gilbert"], "2026-10-01T00:00:00.000Z");
  assert.equal(JSON.stringify(about.map((e) => e.id)), JSON.stringify(["c-1"]));
  assert.equal(S.chatsAbout(entries, ["Deloitte"], "2026-11-03T00:00:00.000Z").length, 0, "older than the window");
});

// ── The import endpoint ──────────────────────────────────────────────────────

function memoryStore() {
  const files = new Map();
  return {
    files,
    mod: {
      readUserStore: async (u, f, fallback) => structuredClone(files.get(`${u}/${f}`) ?? fallback),
      writeUserStore: async (u, f, d) => { files.set(`${u}/${f}`, structuredClone(d)); },
      updateUserStore: async (u, f, fn, fallback) => { const next = fn(structuredClone(files.get(`${u}/${f}`) ?? fallback)); files.set(`${u}/${f}`, structuredClone(next)); return next; },
    },
  };
}

class SpendCapError extends Error {}

function ingestRoute({ user = { username: "michael", authMode: "token" }, digest } = {}) {
  const mem = memoryStore();
  const store = loadTs("lib/ai-chats/store.ts", {
    "@/lib/storage/user-store": mem.mod,
    "./parse": P,
    "./search": S,
  });
  const route = loadTs("app/api/ai-chats/ingest/route.ts", {
    "next/server": { NextResponse: { json: (body, init = {}) => ({ status: init.status ?? 200, body }) } },
    "@/lib/stig/auth": { getStigRequestUser: async () => user },
    "@/lib/ai/spend-guard": { SpendCapError },
    "@/lib/ai-chats/parse": P,
    "@/lib/ai-chats/digest": { digestConversation: digest },
    "@/lib/ai-chats/store": store,
  });
  const post = (body) => route.POST({ json: async () => body });
  return { post, mem, store };
}

const WORK = { work: true, summary: "Priced it.", topics: ["pricing"], people: ["Franz Gilbert"], companies: ["Deloitte"], decisions: [], openItems: [] };
const PERSONAL = { work: false, summary: "", topics: [], people: [], companies: [], decisions: [], openItems: [] };

test("work is kept with its digest and words; personal keeps only id and date", async () => {
  const personalConv = { uuid: "c-2", name: "Knee physio exercises", updated_at: "2026-11-03T00:00:00Z", chat_messages: [{ sender: "human", text: "my knee hurts" }] };
  const { post, mem } = ingestRoute({ digest: async (_u, t) => (t.id === "c-1" ? WORK : PERSONAL) });
  const r = await post({ platform: "claude-chat", conversations: [claudeConv, personalConv] });
  assert.equal(r.status, 200);
  assert.equal(r.body.work, 1);
  assert.equal(r.body.personal, 1);
  const index = mem.files.get("michael/sage-ai-chats.json");
  assert.equal(index.entries["claude-chat:c-1"].title, "AnalystGenius pricing");
  assert.equal(JSON.stringify(index.entries["claude-chat:c-2"]), JSON.stringify({ key: "claude-chat:c-2", platform: "claude-chat", id: "c-2", updatedAt: "2026-11-03T00:00:00.000Z", work: false }), "no title, no words");
  const text = mem.files.get("michael/sage-ai-chats-text.json").excerpts;
  assert.match(text["claude-chat:c-1"], /price AnalystGenius/);
  assert.equal(text["claude-chat:c-2"], undefined);
  assert.ok(!JSON.stringify([...mem.files.values()]).includes("knee"), "nothing personal stored anywhere");
});

test("a conversation is read once per change; failures are retried next time", async () => {
  let calls = 0;
  const { post } = ingestRoute({ digest: async () => { calls++; return calls === 2 ? null : WORK; } });
  await post({ platform: "claude-chat", conversations: [claudeConv] });
  const again = await post({ platform: "claude-chat", conversations: [claudeConv] });
  assert.equal(again.body.unchanged, 1);
  assert.equal(calls, 1, "unchanged conversations are not read again");
  const changed = await post({ platform: "claude-chat", conversations: [{ ...claudeConv, updated_at: "2026-11-09T00:00:00Z" }] });
  assert.equal(changed.body.failed, 1, "a failed read is not recorded…");
  const retry = await post({ platform: "claude-chat", conversations: [{ ...claudeConv, updated_at: "2026-11-09T00:00:00Z" }] });
  assert.equal(retry.body.work, 1, "…so the next sync reads it again");
});

test("the daily AI limit stops the import cleanly and keeps what was read", async () => {
  let n = 0;
  const convs = Array.from({ length: 6 }, (_, i) => ({ ...claudeConv, uuid: `c-${i + 10}` }));
  const { post, mem } = ingestRoute({ digest: async () => { n++; if (n > 4) throw new SpendCapError("cap"); return WORK; } });
  const r = await post({ platform: "claude-chat", conversations: convs });
  assert.equal(r.status, 429);
  assert.equal(r.body.read, 4);
  assert.equal(Object.keys(mem.files.get("michael/sage-ai-chats.json").entries).length, 4);
});

test("refuses without a sign-in, a known platform, or with too many at once", async () => {
  assert.equal((await ingestRoute({ user: null, digest: async () => WORK }).post({ platform: "chatgpt", conversations: [] })).status, 401);
  const { post } = ingestRoute({ digest: async () => WORK });
  assert.equal((await post({ platform: "gemini", conversations: [] })).status, 400);
  assert.equal((await post({ platform: "chatgpt", conversations: "x" })).status, 400);
  assert.equal((await post({ platform: "chatgpt", conversations: Array(26).fill(chatgptConv) })).status, 400);
});

test("each user's conversations stay their own", async () => {
  const { post, mem } = ingestRoute({ user: { username: "guy", authMode: "token" }, digest: async () => WORK });
  await post({ platform: "chatgpt", conversations: [chatgptConv] });
  assert.ok(mem.files.has("guy/sage-ai-chats.json"));
  assert.ok(![...mem.files.keys()].some((k) => k.startsWith("michael/")));
});

// ── Wired in (2026-11-17) ────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

test("Ask Basil can search them, and treats what comes back as outside content", () => {
  assert.match(src("lib/ai/tools.ts"), /searchAIChats: tool\(\{/);
  assert.match(src("lib/ai/injection-guard.ts"), /"searchAIChats"/, "conversations hold pasted text written by others");
  assert.match(src("lib/ai/system-prompt.ts"), /\*\*Claude & ChatGPT\*\*[^\n]*searchAIChats/);
  assert.match(src("lib/ai-chats/digest.ts"), /DATA_NOT_INSTRUCTIONS/, "the digest prompt is told its input is data");
});

test("meeting prep and the briefing draw on them; a failure never blocks either", () => {
  const prep = src("app/api/generate/meeting-prep/route.ts");
  assert.match(prep, /chatsAbout\(Object\.values\(entries\), \[\.\.\.attendeeNames, \.\.\.attendeeCompanies\]/);
  assert.match(prep, /\.catch\(\(e\) => \{ console\.warn\("\[meeting-prep\] AI conversations unavailable/);
  const brief = src("app/api/generate/briefing/route.ts");
  assert.match(brief, /\.filter\(\(e\) => e\.work && e\.updatedAt >= aiChatSince\)/, "work conversations only");
  assert.match(brief, /\.catch\(\(e\) => \{ console\.warn\("\[briefing\] AI conversations unavailable/);
});
