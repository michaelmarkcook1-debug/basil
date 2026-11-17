/**
 * What Basil has learned from the user's Claude and ChatGPT conversations.
 *
 *   sage-ai-chats.json       — one entry per conversation seen. Work ones carry
 *                              title, link and the digest; personal ones only
 *                              id and date, so they are never read twice.
 *   sage-ai-chats-text.json  — for work conversations only, an excerpt of what
 *                              was said, for search. Read only when searching.
 *
 * Fed by POST /api/ai-chats/ingest (scripts/basil-ai-chats.mjs reads the
 * conversations through the user's logged-in Chrome).
 */
import "server-only";
import { readUserStore, updateUserStore } from "@/lib/storage/user-store";
import { chatKey, type ChatPlatform, type ChatTranscript } from "./parse";
import type { ChatDigest } from "./digest";
import { searchChats, type ChatEntry, type ChatHit } from "./search";

const INDEX_FILE = "sage-ai-chats.json";
const TEXT_FILE = "sage-ai-chats-text.json";
/** Excerpt kept per work conversation: the user's own words first. */
const EXCERPT_CHARS = 3_000;
/** Excerpts kept for at most this many work conversations (the most recent). */
const MAX_EXCERPTS = 800;

export interface ChatIndex {
  entries: Record<string, ChatEntry>;
  /** Per platform: when the user's browser last sent conversations. */
  lastSync: Partial<Record<ChatPlatform, string>>;
}
const EMPTY_INDEX: ChatIndex = { entries: {}, lastSync: {} };
const EMPTY_TEXT: { excerpts: Record<string, string> } = { excerpts: {} };

export async function readChatIndex(username: string): Promise<ChatIndex> {
  const idx = await readUserStore<ChatIndex>(username, INDEX_FILE, EMPTY_INDEX);
  return { entries: idx.entries ?? {}, lastSync: idx.lastSync ?? {} };
}

/** key → updatedAt of every conversation already read, so the browser sends only new or changed ones. */
export async function seenConversations(username: string): Promise<Record<string, string>> {
  const { entries } = await readChatIndex(username);
  return Object.fromEntries(Object.values(entries).map((e) => [e.key, e.updatedAt]));
}

function excerptOf(t: ChatTranscript): string {
  const mine = t.messages.filter((m) => m.role === "user").map((m) => m.text).join("\n\n");
  const theirs = t.messages.filter((m) => m.role === "assistant").map((m) => m.text.slice(0, 400)).join("\n\n");
  return `${mine}\n\n${theirs}`.slice(0, EXCERPT_CHARS);
}

/** Record what was read. Personal conversations keep only id and date. */
export async function saveDigests(
  username: string,
  platform: ChatPlatform,
  results: Array<{ t: ChatTranscript; digest: ChatDigest }>,
): Promise<void> {
  const now = new Date().toISOString();
  const entries: ChatEntry[] = results.map(({ t, digest }) => digest.work
    ? {
        key: chatKey(t), platform: t.platform, id: t.id, updatedAt: t.updatedAt, work: true,
        title: t.title.slice(0, 200), url: t.url, ...(t.createdAt ? { createdAt: t.createdAt } : {}),
        summary: digest.summary, topics: digest.topics, people: digest.people, companies: digest.companies,
        decisions: digest.decisions, openItems: digest.openItems,
      }
    : { key: chatKey(t), platform: t.platform, id: t.id, updatedAt: t.updatedAt, work: false });

  await updateUserStore<ChatIndex>(username, INDEX_FILE, (cur) => {
    const next: ChatIndex = { entries: { ...(cur.entries ?? {}) }, lastSync: { ...(cur.lastSync ?? {}), [platform]: now } };
    for (const e of entries) next.entries[e.key] = e;
    return next;
  }, EMPTY_INDEX);

  const work = results.filter((r) => r.digest.work);
  const personalKeys = new Set(results.filter((r) => !r.digest.work).map((r) => chatKey(r.t)));
  if (work.length === 0 && personalKeys.size === 0) return;
  const { entries: all } = await readChatIndex(username);
  await updateUserStore<typeof EMPTY_TEXT>(username, TEXT_FILE, (cur) => {
    const excerpts = { ...(cur.excerpts ?? {}) };
    for (const { t } of work) excerpts[chatKey(t)] = excerptOf(t);
    // A conversation that turned personal on a later read loses its words.
    for (const k of personalKeys) delete excerpts[k];
    // Keep the most recent work conversations' words; older ones stay findable by their digest.
    const keys = Object.keys(excerpts).sort((a, b) => ((all[a]?.updatedAt ?? "") < (all[b]?.updatedAt ?? "") ? 1 : -1));
    for (const k of keys.slice(MAX_EXCERPTS)) delete excerpts[k];
    return { excerpts };
  }, EMPTY_TEXT, { allowShrink: true });
}

/** Mark that a sync ran even when nothing was new. */
export async function touchSync(username: string, platform: ChatPlatform): Promise<void> {
  await updateUserStore<ChatIndex>(username, INDEX_FILE, (cur) => ({
    entries: cur.entries ?? {},
    lastSync: { ...(cur.lastSync ?? {}), [platform]: new Date().toISOString() },
  }), EMPTY_INDEX);
}

export async function searchAIChats(username: string, query: string, limit = 8): Promise<ChatHit[]> {
  const [{ entries }, text] = await Promise.all([
    readChatIndex(username),
    readUserStore<typeof EMPTY_TEXT>(username, TEXT_FILE, EMPTY_TEXT),
  ]);
  return searchChats(Object.values(entries), text.excerpts ?? {}, query, limit);
}

export interface ChatStatus {
  platforms: Array<{ platform: ChatPlatform; lastSync: string | null; work: number; personal: number }>;
  latestWork: Array<Pick<ChatEntry, "platform" | "title" | "url" | "updatedAt" | "summary">>;
}

export async function chatStatus(username: string): Promise<ChatStatus> {
  const { entries, lastSync } = await readChatIndex(username);
  const list = Object.values(entries);
  const count = (p: ChatPlatform, work: boolean) => list.filter((e) => e.platform === p && e.work === work).length;
  return {
    platforms: (["claude-chat", "chatgpt"] as const).map((p) => ({ platform: p, lastSync: lastSync[p] ?? null, work: count(p, true), personal: count(p, false) })),
    latestWork: list.filter((e) => e.work).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 10)
      .map((e) => ({ platform: e.platform, title: e.title, url: e.url, updatedAt: e.updatedAt, summary: e.summary })),
  };
}
